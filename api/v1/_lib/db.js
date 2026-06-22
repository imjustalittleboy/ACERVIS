// ACERVIS: Database Helper
import { neon } from '@neondatabase/serverless';

let _sql = null;

export function getDb() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// Build and execute a parameterized query without fragment nesting.
// Uses the tagged template function manually: sql(['...', '...', ''], val1, val2)
// @param {function} sql - the neon connection function from getDb()
// @param {string} text - SQL with $1, $2, $3 placeholders
// @param {array} params - parameter values
// @returns {Promise<array>} rows
export async function exec(sql, text, params = []) {
  // Split text on $N placeholders to create template string parts
  const parts = text.split(/\$\d+/);
  // Add raw property for TemplateStringsArray compatibility
  parts.raw = parts;
  return sql(parts, ...params);
}
