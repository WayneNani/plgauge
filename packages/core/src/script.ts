/** Splitting SQL*Plus style scripts into statements. */

/** SQL*Plus commands between statements (SET TRANSACTION, ROLE and CONSTRAINTS are SQL). */
const SQLPLUS = /^\s*(PROMPT|PRO|SET(?!\s+(TRANSACTION|ROLE|CONSTRAINTS?)\b)|SPOOL|WHENEVER|DEFINE|DEF|UNDEFINE|SHOW|SHO|EXIT|QUIT|REM|REMARK|COLUMN|COL|TTITLE|BTITLE|PAUSE|CLEAR|VAR|VARIABLE|PRINT|ACCEPT|TIMING|BREAK|COMPUTE|HOST|LIST|CONNECT|CONN|DISCONNECT)(\s|$)|^\s*@/i;
const PLSQL_START = /^\s*(CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE)\b|DECLARE\b|BEGIN\b)/i;

/** A line's code without comments and string contents; comment/quote carry over lines. */
function scan(line: string, comment: boolean, quote: boolean): { code: string; comment: boolean; quote: boolean } {
  let code = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (comment) {
      if (c === '*' && line[i + 1] === '/') {
        comment = false;
        i++;
      }
    } else if (quote) {
      if (c === "'") quote = false;
    } else if (c === "'") {
      quote = true;
      code += "'";
    } else if (c === '-' && line[i + 1] === '-') break;
    else if (c === '/' && line[i + 1] === '*') {
      comment = true;
      i++;
    } else code += c;
  }
  return { code, comment, quote };
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
  let comment = false;
  let quote = false;
  const flush = (stmt: string) => {
    if (stmt.trim()) out.push(stmt);
    buf = [];
    code = '';
  };
  for (const line of text.split('\n')) {
    const between = !code.trim() && !comment && !quote;
    if (between && !line.trim() && !buf.length) continue;
    if (!comment && !quote && line.trim() === '/') {
      flush(buf.join('\n'));
      continue;
    }
    if (between && SQLPLUS.test(line)) continue;
    if (between && /^\s*EXEC(UTE)?\s+/i.test(line)) {
      flush(buf.join('\n')); // (comments before it)
      out.push(`BEGIN ${line.trim().replace(/^EXEC(UTE)?\s+/i, '').replace(/;\s*$/, '')}; END;`);
      continue;
    }
    const r = scan(line, comment, quote);
    comment = r.comment;
    quote = r.quote;
    buf.push(line);
    code += r.code + '\n';
    // PL/SQL is known once its first code is (CREATE OR REPLACE may stand on a line of its own)
    const plsql = PLSQL_START.test(code);
    if (!plsql && !comment && !quote && /;\s*$/.test(r.code) && code.trim()) {
      flush(buf.join('\n').replace(/;(\s*(--.*)?)$/, '$1').replace(/\s+$/, ''));
    }
  }
  flush(buf.join('\n'));
  return out;
}
