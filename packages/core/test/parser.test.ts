/** The core parser: structure, precedence, and the constructs it reads instead of giving up. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseUnit, walk, type Node } from '@pltest/core';

/** The tree as a compact string: kind[op](children). */
function shape(n: Node, tokens: { text: string }[]): string {
  const leaf = ['name', 'lit'].includes(n.k);
  if (leaf) return tokens.slice(n.a, n.b).map((t) => t.text).join('');
  const inner = n.kids.map((k) => shape(k, tokens)).join(',');
  return `${n.k}${n.op ? `[${n.op}]` : ''}(${inner})`;
}

function expr(src: string): string {
  const p = parseUnit(`procedure p is begin x := ${src}; end;`);
  const asg = p.unit.kids[0].kids.find((k) => k.k === 'body')!.kids[0].kids[0];
  return shape(asg.kids[1], p.tokens);
}

test('parser: Oracle precedence, left to right within a level', () => {
  assert.equal(expr('a - b + c'), 'bin[+](bin[-](a,b),c)');
  assert.equal(expr('a / b * c'), 'bin[*](bin[/](a,b),c)');
  assert.equal(expr("'n' || a + b"), "bin[+](bin[||]('n',a),b)"); // || shares the level of + and -
  assert.equal(expr('-a ** 2'), 'unary[-](bin[**](a,2))');
  assert.equal(expr('n mod 2 = 0'), 'cmp[=](bin[MOD](n,2),0)');
  assert.equal(expr('a or b and not c'), 'logic[OR](a,logic[AND](b,not(c)))');
  assert.equal(expr('x between 1 and 5 and y is null'), 'logic[AND](pred[BETWEEN](x,1,5),isnull(y))');
  assert.equal(expr('o is not null and o is of (t)'), 'logic[AND](isnull(o),pred[IS](o))');
});

test('parser: generalized invocation, argument clauses and MULTISET are understood', () => {
  assert.equal(expr('(self as t_base).name(1)'), 'call(paren(cast[AS](self)),arg(1))');
  assert.equal(expr('cast(a + 1 as number)'), 'call(arg(clause(bin[+](a,1))))');
  assert.equal(expr('extract(day from d - 1)'), 'call(arg(clause(day,bin[-](d,1))))');
  assert.equal(expr("trim(leading '0' from s)"), "call(arg(clause('0',s)))");
  assert.equal(expr('a multiset union all b'), 'clause[MULTISET](a,b)');
  assert.equal(expr("json_value(d, '$.a' returning number)"), "call(arg(d),arg(clause('$.a')))");
});

test('parser: FOR filters (21c), cursor attributes, compound triggers', () => {
  const p = parseUnit(`procedure p is begin
    for i in 1 .. 10 by 2 while i < 8 when mod(i, 3) = 0 loop null; end loop;
    if c%notfound then null; end if;
  end;`);
  const seq = p.unit.kids[0].kids.find((k) => k.k === 'body')!.kids[0];
  const loop = seq.kids[0];
  assert.equal(loop.name, 'for');
  assert.deepEqual(loop.kids.filter((k) => k.k !== 'seq').map((k) => `${k.k}${k.name ? ':' + k.name : ''}`), ['range:by', 'branch:for-while', 'branch:for-when']);
  const cond = seq.kids[1].kids[0].kids[0];
  assert.equal(cond.k, 'name');
  assert.equal(p.tokens[cond.at! + 1].up, 'NOTFOUND');

  const t = parseUnit(`trigger trg for insert on t compound trigger
    g pls_integer := 0;
    before each row is begin g := g + 1; end before each row;
    after statement is begin null; end after statement;
  end trg;`);
  assert.deepEqual(t.unit.kids.map((k) => k.k), ['decls', 'section', 'section']);
});

test('parser: a file with several units, SQL*Plus and an error in one unit', () => {
  const p = parse(`prompt installing
create or replace package body a is
  procedure x is begin if a then null; end; end;
end;
/
create or replace function b return number is begin return 1; end;
/
`);
  assert.deepEqual(p.units.map((u) => `${u.op} ${u.name}`), ['FUNCTION b']);
  assert.equal(p.errors.length, 1);
});

test('parser: nothing it does not understand is silently mis-parsed', () => {
  // unknown syntax becomes an opaque region; the parenthesised group inside is still read
  const p = parseUnit(`procedure p is begin x := a frobnicate (b + 1); end;`);
  const kinds: string[] = [];
  walk(p.unit, (n) => void kinds.push(n.k));
  assert.ok(kinds.includes('opaque'));
  assert.ok(kinds.includes('bin'));
  assert.ok(!kinds.includes('cmp'));
});
