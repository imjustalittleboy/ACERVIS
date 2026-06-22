// ACERVIS: Database Helper
import { neon, sql as neonSql } from '@neondatabase/serverless';

let _sql = null;

export function getDb() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// Import the `sql` fragment helper from neon for building composable fragments
// Usage:
//   import { getDb, frag } from './_lib/db.js';
//   const sql = getDb();
//   const conditions = frag`col = ${val1}`;
//   const rows = await sql`SELECT * FROM t WHERE ${conditions}`;
export function frag(strings, ...values) {
  return neonSql(strings, ...values);
}
