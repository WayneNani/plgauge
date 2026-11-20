// Builds the npm package: the whole CLI as one ES module, dist/plgauge.mjs. Only oracledb stays a
// dependency (thin mode, no Oracle client needed). From a checkout, bin/plgauge runs the sources instead.
import { build } from 'esbuild';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const out = 'dist/plgauge.mjs';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['packages/cli/src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['oracledb'],
  define: { PLGAUGE_VERSION: JSON.stringify(version) },
  outfile: out,
  logLevel: 'warning',
});
// the source's own first line runs it through tsx; the package runs plain node
const js = readFileSync(out, 'utf8').replace(/^#!.*\n/, '');
writeFileSync(out, `#!/usr/bin/env node\n${js}`);
chmodSync(out, 0o755);
console.error(`${out} (plgauge ${version}, ${Math.round(js.length / 1024)} KB)`);
