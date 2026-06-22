// ACERVIS: Database Helper
import { neon } from '@neondatabase/serverless';

let _sql = null;

export function getDb() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// Build a parameterized WHERE clause for dynamic queries.
// Returns { text: "...", params: [...] }
// Use with: sql.unsafe('SELECT * FROM t WHERE ' + result.text, result.params)
//
// Supported condition formats:
//   { 'col': value }         → col = $N  (exact match)
//   { '_raw': { sql, params }} → raw SQL snippet with re-indexed params
//
// _raw handles re-indexing: if 2 params already exist, $1 in raw becomes $3, $2 becomes $4, etc.
export function where(conditions) {
  const clauses = [];
  const params = [];
  let idx = 0;

  for (const [key, value] of Object.entries(conditions)) {
    if (value === undefined || value === null || value === '') continue;

    if (key === '_raw') {
      // Re-index raw SQL parameters
      let rawSql = value.sql;
      const rawParams = [...value.params];
      // Replace $1, $2 etc with $(idx+1), $(idx+2) etc
      const reindexed = rawSql.replace(/\$(\d+)/g, (match, num) => {
        const newIdx = idx + parseInt(num, 10);
        return `$${newIdx}`;
      });
      clauses.push(reindexed);
      params.push(...rawParams);
      idx += rawParams.length;
    } else if (key.endsWith('__ilike')) {
      const col = key.replace('__ilike', '');
      clauses.push(`${col} ILIKE $${++idx}`);
      params.push(value);
    } else {
      clauses.push(`${key} = $${++idx}`);
      params.push(value);
    }
  }

  return {
    text: clauses.join(' AND '),
    params
  };
}
