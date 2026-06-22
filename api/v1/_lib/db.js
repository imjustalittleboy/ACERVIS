// ACERVIS: Database Helper
import { neon } from '@neondatabase/serverless';

let sql = null;

export function getDb() {
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

// Pagination helper — returns { rows, total, page, limit }
export async function paginate(sql, baseQuery, countQuery, params, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const [{ count }] = await sql`${countQuery}`;
  const total = parseInt(count, 10);
  const rows = await sql`${baseQuery} LIMIT ${limit} OFFSET ${offset}`;
  return { rows, total, page, limit, totalPages: Math.ceil(total / limit) };
}
