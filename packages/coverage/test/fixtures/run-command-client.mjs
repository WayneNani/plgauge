// The runCommand of a db.test.ts case: two sessions with different client programs call
// instrumented code, like a UI test against ORDS next to a script that prepares data.
// Usage: node run-command-client.mjs <user> <password> <connectString>
import oracledb from 'oracledb';

const [user, password, connectString] = process.argv.slice(2);

async function call(program, plsql) {
  oracledb.program = program;
  const conn = await oracledb.getConnection({ user, password, connectString });
  try {
    await conn.execute(plsql);
  } finally {
    await conn.close();
  }
}

// raises when a probe between its UPDATE and the SQL%ROWCOUNT check changed the attribute
await call('plgauge-ui', 'begin plgauge_rc_ui; end;');
// filtered out by backgroundProgram
await call('plgauge-other', 'begin plgauge_rc_other; end;');
