// ACERVIS: Audit Log API (v3.1.0)
// GET /api/v1/audit — View audit logs with filters (super admin or institution)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb, exec } from './_lib/db.js';
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

    const clauses = [`TRUE`];
    const sparams = [];
    if (institution) { clauses.push(`al.actor_id = $${sparams.length + 1}`); sparams.push(institution.id); }
    if (action) { clauses.push(`al.action = $${sparams.length + 1}`); sparams.push(action); }
    if (actor_id) { clauses.push(`al.actor_id = $${sparams.length + 1}`); sparams.push(actor_id); }
    if (from) { clauses.push(`al.created_at >= $${sparams.length + 1}`); sparams.push(from); }
    if (to) { clauses.push(`al.created_at <= $${sparams.length + 1}`); sparams.push(to); }
    const awhere = clauses.join(' AND ');

    const [{ count }] = await exec(sql, `SELECT COUNT(*) FROM audit_logs al WHERE ${awhere}`, sparams);
    const total = parseInt(count, 10);

    const rows = await exec(sql,
      `SELECT al.*, i.name AS actor_name, i.short_code AS actor_code
      FROM audit_logs al LEFT JOIN institutions i ON al.actor_id = i.id
      WHERE ${awhere} ORDER BY al.created_at DESC LIMIT ${l} OFFSET ${offset}`,
      sparams
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
