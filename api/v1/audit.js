// ACERVIS: Audit Log API (v3.1.0)
// GET /api/v1/audit — View audit logs with filters (super admin or institution)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
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

    let conditions = sql`1=1`;

    // Institution admins see their own audit logs. Super admin sees all.
    if (institution) {
      conditions = sql`${conditions} AND al.actor_id = ${institution.id}`;
    }

    if (action) conditions = sql`${conditions} AND al.action = ${action}`;
    if (actor_id) conditions = sql`${conditions} AND al.actor_id = ${actor_id}`;
    if (from) conditions = sql`${conditions} AND al.created_at >= ${from}`;
    if (to) conditions = sql`${conditions} AND al.created_at <= ${to}`;

    const [{ count }] = await sql`SELECT COUNT(*) FROM audit_logs al WHERE ${conditions}`;
    const total = parseInt(count, 10);

    const rows = await sql`
      SELECT al.*, i.name AS actor_name, i.short_code AS actor_code
      FROM audit_logs al
      LEFT JOIN institutions i ON al.actor_id = i.id
      WHERE ${conditions}
      ORDER BY al.created_at DESC
      LIMIT ${l} OFFSET ${offset}
    `;

    return res.status(200).json({
      audit_logs: rows,
      pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) }
    });

  } catch (err) {
    console.error('ACV_AUDIT_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
