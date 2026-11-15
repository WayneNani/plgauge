/** Lists the compile errors of the schema behind PLGAUGE_DB / PLMUT_DB (oracle:// URL): tsx scripts/dbg-errors.ts */
import oracledb from 'oracledb';
import { parseDbUrl } from '../packages/mutation/src/session.ts';

const url = process.env.PLGAUGE_DB ?? process.env.PLMUT_DB?.split(',')[0];
if (!url) throw new Error('PLGAUGE_DB oder PLMUT_DB setzen');
const c = await oracledb.getConnection(parseDbUrl(url));
const r = await c.execute<[string, string, number, string]>(`select name, type, line, text from user_errors order by name, sequence`);
for (const x of r.rows ?? []) console.log(`${x[1]} ${x[0]}:${x[2]} ${x[3].trim()}`.slice(0, 200));
await c.close();
