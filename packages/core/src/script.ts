/** Splitting SQL*Plus style scripts into statements. */
import { Q_CLOSERS } from './lexer.js';

/** A SQL*Plus command word in every length it accepts: PRO, PROM, PROMP, PROMPT. */
const abbrev = (min: string, full: string) => min + [...full.slice(min.length)].reduceRight((acc, c) => `(?:${c}${acc})?`, '');
/**
 * SQL*Plus commands (their shortest form and full name) that a script may use between
 * statements; EXEC is handled apart (it becomes a block).
 */
const COMMANDS: [string, string][] = [
  ['ACC', 'ACCEPT'], ['BRE', 'BREAK'], ['BTI', 'BTITLE'], ['CL', 'CLEAR'], ['COL', 'COLUMN'], ['COMP', 'COMPUTE'],
  ['CONN', 'CONNECT'], ['DEF', 'DEFINE'], ['DESC', 'DESCRIBE'], ['DISC', 'DISCONNECT'], ['ED', 'EDIT'], ['EXIT', 'EXIT'],
  ['GET', 'GET'], ['HO', 'HOST'], ['LIST', 'LIST'], ['PASSW', 'PASSWORD'], ['PAU', 'PAUSE'], ['PRI', 'PRINT'],
  ['PRO', 'PROMPT'], ['QUIT', 'QUIT'], ['REM', 'REMARK'], ['REPF', 'REPFOOTER'], ['REPH', 'REPHEADER'], ['RUN', 'RUN'],
  ['SAV', 'SAVE'], ['SHO', 'SHOW'], ['SPO', 'SPOOL'], ['STA', 'START'], ['STORE', 'STORE'], ['TIMI', 'TIMING'],
  ['TTI', 'TTITLE'], ['UNDEF', 'UNDEFINE'], ['VAR', 'VARIABLE'], ['WHENEVER', 'WHENEVER'],
];
/** The command words as a regex alternation (SET without TRANSACTION, ROLE, CONSTRAINTS: those are SQL). */
export const SQLPLUS_WORDS = [...COMMANDS.map(([m, f]) => abbrev(m, f)), 'SET(?!\\s+(TRANSACTION|ROLE|CONSTRAINTS?)\\b)'].join('|');
/** SQL*Plus commands between statements; @file, $ and ! too. */
const SQLPLUS = new RegExp(`^\\s*(${SQLPLUS_WORDS})(\\s|;|$)|^\\s*[@$!]`, 'i');
/** The first word of a SQL statement or PL/SQL block (what SQL*Plus takes as one, not as SP2-0734). */
const SQL_START = /^\s*(<<|\(|(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|COMMIT|ROLLBACK|SAVEPOINT|LOCK|WITH|EXPLAIN|CALL|ANALYZE|AUDIT|NOAUDIT|RENAME|PURGE|FLASHBACK|SET|DECLARE|BEGIN|VALUES|ASSOCIATE|DISASSOCIATE|ADMINISTER|TABLE)\b)/i;
const PLSQL_START = /^\s*(<<|CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE)\b|DECLARE\b|BEGIN\b)/i;
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
    const qq = /[\w$#]/.test(line[i - 1] ?? '') ? null : /^n?q'([^])/i.exec(line.slice(i, i + 4));
    if (qq) {
      quote = (Q_CLOSERS[qq[1]] ?? qq[1]) + "'";
      code += "''";
      i += qq[0].length;
      continue;
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
const CONT = /\s-\s*$/;
const RUN = /^\s*R(UN)?\s*$/i;

export function splitScript(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let code = ''; // the code of the statement so far (comments and strings out)
  let st: ScanState = { comment: false, quote: '' };
  let exec: string[] | undefined;
  let ended = false; // the statement ended, a block comment after its semicolon is still open
  let cont = false; // a SQL*Plus command continues on the next line
  let foreign = false; // in an inline Java/MLE source: only the "/" line ends it
  let parked = false; // SQL cut off by a blank line: run only if "/" follows
  let blankLines = false; // SET SQLBLANKLINES ON: blank lines belong to the statement
  let dropped = false; // after SQL a blank line ended: lines that start no statement are rejected
  let held = ''; // that SQL: still in SQL*Plus's buffer, a later "/" runs it
  let last = ''; // the statement last run: "/" or RUN with nothing new runs it again, as SQL*Plus does
  const joined = () => buf.join('\n').replace(/\s+$/, '');
  const flush = () => {
    // a statement of comments only, or a lone semicolon, is none (ORA-00900)
    if (code.replace(/;\s*$/, '').trim()) out.push((last = joined()));
    buf = [];
    code = '';
  };
  // the statement's entry ends without running it: SQL*Plus keeps it in its buffer
  const hold = () => {
    held = joined();
    buf = [];
    code = '';
    dropped = true;
  };
  // EXEC call;  →  BEGIN call; END;  (continuation lines ending in " -" joined, a trailing comment and the semicolon off)
  const execBlock = (lines: string[]) => {
    let state: ScanState = { comment: false, quote: '' };
    const kept = lines.map((l, i) => {
      if (i < lines.length - 1) l = l.replace(CONT, '');
      const r = scanLine(l, state);
      state = r.state;
      return r.dash >= 0 ? l.slice(0, r.dash) : l;
    });
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
    const t = line.trim();
    if (exec) {
      exec.push(line);
      if (!CONT.test(line)) {
        execBlock(exec);
        exec = undefined;
      }
      continue;
    }
    if (foreign) {
      if (t === '/') {
        foreign = false;
        flush();
      } else buf.push(line);
      continue;
    }
    // a SQL*Plus command continued with " -": this line belongs to it, even a blank one
    if (cont) {
      cont = CONT.test(line);
      continue;
    }
    if (parked) {
      if (!t) continue;
      parked = false;
      if (t === '/') {
        flush();
        continue;
      }
      // SQL*Plus (SQLBLANKLINES OFF) ended the statement at the blank line without running it
      hold();
    }
    const free = !st.comment && !st.quote;
    const between = free && !code.trim();
    // "/" runs the held statement, RUN the held or the last one (SP2 errors and commands leave the buffer)
    if (between && (RUN.test(line) || (held && t === '/'))) {
      const again = held || last;
      held = '';
      dropped = false;
      if (again) out.push((last = again));
      continue;
    }
    // "." alone ends the entry of SQL or PL/SQL without running it (a later "/" does)
    if (free && t === '.' && code.trim()) {
      hold();
      continue;
    }
    // the rest of it: SQL*Plus reads each line as a new command and rejects those that start none
    if (dropped && free) {
      // (blank and comment lines change nothing: the next line is a new command still)
      if (!t || /^\s*--/.test(line)) continue;
      if (SQLPLUS.test(line) || SQL_START.test(line) || /^\s*(\/\*|EXEC(UTE)?\s)/i.test(line)) dropped = false;
      else continue;
    }
    // a blank line in unfinished SQL (not PL/SQL) ends its entry, also inside a string or comment:
    // SQL*Plus reads lines, not literals (SET SQLBLANKLINES ON is the way to keep one)
    if (!blankLines && !t && code.trim() && !PLSQL_START.test(code) && !WITH_PLSQL.test(code) && !FOREIGN_HEAD.test(code)) {
      parked = true;
      st = { comment: false, quote: '' };
      continue;
    }
    if (between && !t && !buf.length) continue;
    if (free && t === '/') {
      // nothing new since the last statement: SQL*Plus runs that one again
      if (!code.replace(/;\s*$/, '').trim() && last) out.push(last);
      else flush();
      continue;
    }
    if (between) {
      // EXIT/QUIT: SQL*Plus stops here
      if (/^\s*(EXIT|QUIT)(\s|;|$)/i.test(line)) break;
      // a SQL*Plus command, with its continuation lines (" -" at the end)
      if (SQLPLUS.test(line)) {
        const bl = /^\s*SET\b.*\bSQLBL[A-Z]*\s+(ON|OFF)\b/i.exec(line);
        if (bl) blankLines = bl[1].toUpperCase() === 'ON';
        cont = CONT.test(line);
        continue;
      }
      if (/^\s*EXEC(UTE)?\s+/i.test(line)) {
        flush(); // comments before it go
        if (CONT.test(line)) exec = [line];
        else execBlock([line]);
        continue;
      }
      // a line that starts neither a statement, a block nor a command: SQL*Plus rejects it (SP2-0734)
      if (t && !SQL_START.test(line) && !/^\s*(--|\/\*)/.test(line)) continue;
    }
    const r = scanLine(line, st);
    st = r.state;
    buf.push(line);
    code += r.code + '\n';
    // a new statement replaces the buffer
    if (r.code.trim()) held = '';
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
  // a statement without its terminator at the end stays in SQL*Plus's buffer, never run (a block
  // comment still open after a semicolon: that statement had ended)
  if (ended) flush();
  return out;
}
