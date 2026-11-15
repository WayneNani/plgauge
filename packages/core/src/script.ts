/** Splitting SQL*Plus style scripts into statements. */

/** SQL*Plus commands between statements (SET TRANSACTION, ROLE and CONSTRAINTS are SQL). */
const SQLPLUS = /^\s*(PROMPT|PRO|SET(?!\s+(TRANSACTION|ROLE|CONSTRAINTS?)\b)|SPOOL|WHENEVER|DEFINE|DEF|UNDEFINE|SHOW|SHO|EXIT|QUIT|REM|REMARK|COLUMN|COL|TTITLE|BTITLE|PAUSE|CLEAR|VAR|VARIABLE|PRINT|ACCEPT|TIMING|BREAK|COMPUTE|HOST|LIST|CONNECT|CONN|DISCONNECT|START|RUN|GET|DESC|DESCRIBE)(\s|;|$)|^\s*[@$!]/i;
const PLSQL_START = /^\s*(CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE)\b|DECLARE\b|BEGIN\b)/i;
/**
 * Other statements SQL*Plus ends only at "/": with PL/SQL in a WITH clause (a query, a view; a
 * declaration, not a column named FUNCTION: START WITH function IS NULL).
 */
const WITH_PLSQL = /\bWITH\s+(FUNCTION|PROCEDURE)\s+(?!(IS|AS|IN|NOT|LIKE|BETWEEN|RETURN)\b)("[^"]*"|[A-Za-z][\w$#.]*)\s*(\(|RETURN\b|IS\b|AS\b)/i;
const MLE_INLINE = /^\s*CREATE\b[^;]*?\b(FUNCTION|PROCEDURE)\b[^;]*?\b(AS|IS)\s+MLE\s+LANGUAGE\b/i;
/** An MLE module or Java source (its code may follow AS; whether it does is inlineForeign's). */
export const FOREIGN_HEAD = /^\s*CREATE\s+(OR\s+REPLACE\s+)?(AND\s+(RE)?(COMPILE|RESOLVE)\s+)?((NO)?FORCE\s+)?((NON)?EDITIONABLE\s+)?(MLE\s+MODULE|JAVA\s+SOURCE)\b/i;

/**
 * An MLE module or Java source with its code inline (… AS code, AS outside parentheses; the
 * USING BFILE/CLOB forms end at ";"): JavaScript or Java up to the "/" line, where SQL quoting
 * rules mean nothing (don't, '\''). code: the statement's code so far (scanLine).
 */
export function inlineForeign(code: string): boolean {
  // a call spec with JavaScript inline: … AS MLE LANGUAGE JAVASCRIPT {{ code }}
  if (MLE_INLINE.test(code)) return true;
  const m = FOREIGN_HEAD.exec(code);
  if (!m) return false;
  let depth = 0;
  const rest = code.slice(m[0].length);
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /^AS\b/i.test(rest.slice(i, i + 3)) && !/[\w$#]/.test(rest[i - 1] ?? '')) return true;
  }
  return false;
}

/** Where a line ends: in a block comment, in a string or quoted name (its closing text), or in code. */
export interface ScanState {
  comment: boolean;
  /** "'" in a string, '"' in a quoted name, "]'" and the like in a q-quote ('' outside). */
  quote: string;
}

const Q_CLOSE: Record<string, string> = { '[': ']', '{': '}', '<': '>', '(': ')' };

/**
 * A line's code without comments and the contents of strings and quoted names (a string stays
 * as '' in it); the state carries over to the next line. Knows q'[…]' quotes and "names".
 */
export function scanLine(line: string, st: ScanState): { code: string; state: ScanState; semi: number; dash: number } {
  let { comment, quote } = st;
  let code = '';
  let i = 0;
  let semi = -1; // the last semicolon of the code
  let dash = -1; // where a -- comment starts
  while (i < line.length) {
    const c = line[i];
    if (comment) {
      const e = line.indexOf('*/', i);
      if (e < 0) return { code, state: { comment, quote }, semi, dash };
      i = e + 2;
      comment = false;
      continue;
    }
    if (quote) {
      const e = line.indexOf(quote, i);
      if (e < 0) return { code, state: { comment, quote }, semi, dash };
      // '' inside a string is a quote, not its end
      if (quote === "'" && line[e + 1] === "'") {
        i = e + 2;
        continue;
      }
      i = e + quote.length;
      quote = '';
      continue;
    }
    const free = !/[\w$#]/.test(line[i - 1] ?? '');
    if (free && (((c === 'q' || c === 'Q') && line[i + 1] === "'" && line[i + 2]) || ((c === 'n' || c === 'N') && /[qQ]/.test(line[i + 1] ?? '') && line[i + 2] === "'"))) {
      const k = c === 'n' || c === 'N' ? i + 1 : i;
      const d = line[k + 2];
      if (d) {
        quote = (Q_CLOSE[d] ?? d) + "'";
        code += "''";
        i = k + 3;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      quote = c;
      code += c + c;
      i++;
    } else if (c === '-' && line[i + 1] === '-') {
      dash = i;
      break;
    } else if (c === '/' && line[i + 1] === '*') {
      comment = true;
      i += 2;
    } else {
      if (c === ';') semi = i;
      code += c;
      i++;
    }
  }
  return { code, state: { comment, quote }, semi, dash };
}

/**
 * Splits a SQL*Plus style script into statements: a PL/SQL unit or block ends at "/" on its
 * own line, SQL at its semicolon (outside comments and strings). Header comments stay with the
 * statement after them; SQL*Plus commands between statements drop out, EXEC becomes a block.
 */
export function splitScript(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let code = ''; // the code of the statement so far (comments and strings out)
  let st: ScanState = { comment: false, quote: '' };
  let exec: string[] | undefined;
  let ended = false; // the statement ended, a block comment after its semicolon is still open
  let cont = false;
  let foreign = false; // in an inline Java/MLE source: only the "/" line ends it
  let parked = false; // SQL cut off by a blank line: run only if "/" follows // a SQL*Plus command continues on the next line
  const flush = () => {
    // a statement of comments only, or a lone semicolon, is none (ORA-00900)
    if (code.replace(/;\s*$/, '').trim()) out.push(buf.join('\n').replace(/\s+$/, ''));
    buf = [];
    code = '';
  };
  // EXEC call;  →  BEGIN call; END;  (continuation lines ending in " -" joined, a trailing comment and the semicolon off)
  const execBlock = (lines: string[]) => {
    const parts = lines.map((l, i) => (i < lines.length - 1 ? l.replace(/\s-\s*$/, '') : l));
    let state: ScanState = { comment: false, quote: '' };
    const kept: string[] = [];
    for (const l of parts) {
      const r = scanLine(l, state);
      state = r.state;
      kept.push(r.dash >= 0 ? l.slice(0, r.dash) : l);
    }
    const body = kept.join('\n').replace(/^\s*EXEC(UTE)?\s+/i, '').trim().replace(/;\s*$/, '');
    if (body) out.push(`BEGIN ${body}; END;`);
  };
  for (let line of text.split('\n')) {
    if (ended) {
      const r = scanLine(line, st);
      st = r.state;
      if (st.comment) {
        buf.push(line);
        continue;
      }
      // the comment closes here: it belongs to the statement before, code after it starts the next
      const at = line.indexOf('*/') + 2;
      buf.push(line.slice(0, at));
      ended = false;
      flush();
      st = { comment: false, quote: '' };
      line = line.slice(at);
      if (!line.trim()) continue;
    }
    if (exec) {
      exec.push(line);
      if (!/\s-\s*$/.test(line)) {
        execBlock(exec);
        exec = undefined;
      }
      continue;
    }
    if (foreign) {
      if (line.trim() === '/') {
        foreign = false;
        flush();
      } else buf.push(line);
      continue;
    }
    // a SQL*Plus command continued with " -": this line belongs to it, even a blank one
    if (cont) {
      cont = /\s-\s*$/.test(line);
      continue;
    }
    if (parked) {
      if (!line.trim()) continue;
      parked = false;
      if (line.trim() === '/') {
        flush();
        continue;
      }
      // SQL*Plus (SQLBLANKLINES OFF) ended the statement at the blank line without running it
      buf = [];
      code = '';
    }
    // a blank line in unfinished SQL (not PL/SQL, not in a string or comment) ends its entry
    if (!line.trim() && code.trim() && !st.comment && !st.quote && !PLSQL_START.test(code) && !WITH_PLSQL.test(code)) {
      parked = true;
      continue;
    }
    const between = !code.trim() && !st.comment && !st.quote;
    if (between && !line.trim() && !buf.length) continue;
    if (!st.comment && !st.quote && line.trim() === '/') {
      flush();
      continue;
    }
    // a SQL*Plus command, with its continuation lines (" -" at the end)
    if (between && SQLPLUS.test(line)) {
      cont = /\s-\s*$/.test(line);
      continue;
    }
    if (between && /^\s*EXEC(UTE)?\s+/i.test(line)) {
      flush(); // comments before it go
      if (/\s-\s*$/.test(line)) exec = [line];
      else execBlock([line]);
      continue;
    }
    const r = scanLine(line, st);
    st = r.state;
    buf.push(line);
    code += r.code + '\n';
    // PL/SQL is known once its first code is (CREATE OR REPLACE may stand on a line of its own)
    if (inlineForeign(code)) {
      foreign = true;
      st = { comment: false, quote: '' };
      continue;
    }
    const plsql = PLSQL_START.test(code) || WITH_PLSQL.test(code);
    // (a block comment may follow the semicolon: its content is not in the code)
    if (!plsql && !st.quote && /;\s*$/.test(r.code) && code.trim()) {
      // the statement without its semicolon (a trailing comment stays, a block comment up to its end)
      buf[buf.length - 1] = line.slice(0, r.semi) + line.slice(r.semi + 1);
      if (st.comment) ended = true;
      else flush();
    }
  }
  if (exec) execBlock(exec);
  // (cut off by a blank line and never run)
  if (parked) {
    buf = [];
    code = '';
  }
  flush();
  return out;
}
