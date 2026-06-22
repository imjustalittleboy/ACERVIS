// ACERVIS: Audit Log API (v3.1.0)
// GET /api/v1/audit — View audit logs with filters (super admin or institution)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb, where } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, OPTIONS');

  if (req.method !== 'GET') return error(res, 'ACV_405', 'Method not allowed', 405);

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);

    if (!institution && !isSuperAdmin) {
      return error(res, 'ACV_401', 'Authentication required', 401);
    }

    const { page, limit, action, actor_id, from, to } = req.query;
    const p = parseInt(page, 10) || 1;
    const l = Math.min(parseInt(limit, 10) || 50, 200);
    const offset = (p - 1) * l;

    const aCond = {};
    if (institution) aCond['al.actor_id'] = institution.id;
    if (action) aCond['al.action'] = action;
    if (actor_id) aCond['al.actor_id'] = actor_id;
    // from/to use raw SQL since they're only applied when present
    if (from || to) {
      const rawParts = [];
      const rawParams = [];
      if (from) { rawParts.push(`al.created_at >= $1`); rawParams.push(from); }
      if (to) { rawParts.push(`al.created_at <= $${rawParams.length + 1}`); rawParams.push(to); }
      aCond['_raw'] = { sql: rawParts.join(' AND '), params: rawParams };
    }
    const w = where(aCond);
    const aw = w.text ? `WHERE ${w.text}` : '';

    const [{ count }] = await sql.unsafe(`SELECT COUNT(*) FROM audit_logs al ${aw}`, w.params);
    const total = parseInt(count, 10);

    const rows = await sql.unsafe(
      `SELECT al.*, i.name AS actor_name, i.short_code AS actor_code
      FROM audit_logs al LEFT JOIN institutions i ON al.actor_id = i.id
      ${aw} ORDER BY al.created_at DESC LIMIT ${l} OFFSET ${offset}`,
      w.params
    );

    return res.status(200).json({
      audit_logs: rows,
      pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) }
    });

  } catch (err) {
    console.error('ACV_AUDIT_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
