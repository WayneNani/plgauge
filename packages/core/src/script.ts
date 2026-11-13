/** Splitting SQL*Plus style scripts into statements. */
/** Splits a SQL*Plus style script into statements ("/" on its own line ends PL/SQL, ";" ends SQL). */
export function splitScript(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let plsql = false;
  for (const line of text.split('\n')) {
    if (!buf.length && !line.trim()) continue;
    if (line.trim() === '/') {
      if (buf.length) out.push(buf.join('\n'));
      buf = [];
      plsql = false;
      continue;
    }
    if (!buf.length) plsql = /^\s*create\s+(or\s+replace\s+)?(editionable\s+|noneditionable\s+)?(package|procedure|function|trigger|type)\b/i.test(line) || /^\s*(declare|begin)\b/i.test(line);
    buf.push(line);
    if (!plsql && /;\s*$/.test(line)) {
      out.push(buf.join('\n').replace(/;\s*$/, ''));
      buf = [];
    }
  }
  if (buf.join('').trim()) out.push(buf.join('\n'));
  return out;
}

