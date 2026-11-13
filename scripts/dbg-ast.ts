/** Prints the syntax tree of a file between two lines: tsx scripts/dbg-ast.ts file from to [depth] */
import { readFileSync } from 'node:fs';
import { parse, type Node } from '../packages/core/src/index.ts';
import { prepare } from '../packages/mutation/src/find.ts';
const [file, from, to, depth] = [process.argv[2], Number(process.argv[3] ?? 1), Number(process.argv[4] ?? 1e9), Number(process.argv[5] ?? 99)];
const src = prepare(readFileSync(file, 'utf8')).text;
const p = parse(src);
console.log('errors', p.errors);
const show = (n: Node, d: number) => {
  const a = p.tokens[n.a], z = p.tokens[Math.max(n.a, n.b - 1)];
  if (!a || z.line < from || a.line > to || d > depth) return;
  const txt = src.slice(a.start, z.end).replace(/\s+/g, ' ');
  console.log(`${'  '.repeat(d)}${n.k}${n.op ? ' ' + n.op : ''}${n.name ? ' [' + n.name + ']' : ''} ${a.line}-${z.line}: ${txt.length > 90 ? txt.slice(0, 90) + '…' : txt}`);
  n.kids.forEach((k) => show(k, d + 1));
};
p.units.forEach((u) => show(u, 0));
