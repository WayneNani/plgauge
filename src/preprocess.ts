/**
 * Offline stand-in for DBMS_PREPROCESSOR, used when plcov works on files instead of a database
 * (corpus check, `plcov instrument`). Like plmut, it keeps the LAST branch of every
 * $IF ... $ELSIF ... $ELSE ... $END block and replaces directives and all other branches with
 * spaces, keeping every line break. Offsets, lines and columns therefore stay valid for the file.
 * $ERROR ... $END is blanked completely. In the database flow the real DBMS_PREPROCESSOR is used.
 */
import { tokenize } from './lexer.js';

export function preprocess(src: string): string {
  const toks = tokenize(src).filter((t) => t.kind === 'ident' && t.up.startsWith('$'));
  if (!toks.length) return src;
  const blank: [number, number][] = [];
  type Frame = { kind: 'if' | 'error'; start: number; branches: [number, number][]; branchStart: number };
  const stack: Frame[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const top = stack[stack.length - 1];
    const thenAfter = (from: number) => {
      for (let j = from + 1; j < toks.length; j++) if (toks[j].up === '$THEN') return j;
      throw new Error(`$THEN fehlt nach ${t.text} (Zeile ${t.line})`);
    };
    switch (t.up) {
      case '$IF': {
        const j = thenAfter(k);
        blank.push([t.start, toks[j].end]);
        stack.push({ kind: 'if', start: t.start, branches: [], branchStart: toks[j].end });
        k = j;
        break;
      }
      case '$ELSIF': {
        if (!top || top.kind !== 'if') throw new Error(`$ELSIF ohne $IF (Zeile ${t.line})`);
        const j = thenAfter(k);
        top.branches.push([top.branchStart, t.start]);
        blank.push([t.start, toks[j].end]);
        top.branchStart = toks[j].end;
        k = j;
        break;
      }
      case '$ELSE': {
        if (!top || top.kind !== 'if') throw new Error(`$ELSE ohne $IF (Zeile ${t.line})`);
        top.branches.push([top.branchStart, t.start]);
        blank.push([t.start, t.end]);
        top.branchStart = t.end;
        break;
      }
      case '$ERROR':
        stack.push({ kind: 'error', start: t.start, branches: [], branchStart: t.end });
        break;
      case '$END': {
        const f = stack.pop();
        if (!f) throw new Error(`$END ohne $IF (Zeile ${t.line})`);
        if (f.kind === 'error') blank.push([f.start, t.end]);
        else {
          for (const b of f.branches) blank.push(b); // all but the last branch
          blank.push([t.start, t.end]);
        }
        break;
      }
      default:
        break; // inquiry directives like $$plsql_unit stay
    }
  }
  if (stack.length) throw new Error('$IF ohne $END');
  const chars = src.split('');
  for (const [a, b] of blank) for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' ';
  return chars.join('');
}
