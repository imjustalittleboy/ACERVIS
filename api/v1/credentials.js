// ACERVIS: Credential Management API (v3.1.0)
// GET  /api/v1/credentials          — List with filters (institution admin or super admin)
// POST /api/v1/credentials          — Search by name/matric (institution admin)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';
import { verifyIntegrity } from './_lib/crypto.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, POST, OPTIONS');

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);

    // ── GET: List with filters ──
    if (req.method === 'GET') {
      const { page, limit, status, search, institution_id, from, to } = req.query;

      // Scoped to authenticated institution unless super admin
      const instId = institution ? institution.id : (isSuperAdmin && institution_id ? institution_id : null);
      if (!instId) return error(res, 'ACV_401', 'Authentication required', 401);

      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;

      let conditions = sql`c.institution_id = ${instId}`;
      if (status) conditions = sql`${conditions} AND c.status = ${status}`;
      if (search) conditions = sql`${conditions} AND (c.student_name ILIKE ${'%' + search + '%'} OR c.matric_number ILIKE ${'%' + search + '%'} OR c.ncn ILIKE ${'%' + search + '%'})`;
      if (from) conditions = sql`${conditions} AND c.issued_at >= ${from}`;
      if (to) conditions = sql`${conditions} AND c.issued_at <= ${to}`;

      const [{ count }] = await sql`
        SELECT COUNT(*) FROM credentials c WHERE ${conditions}
      `;
      const total = parseInt(count, 10);

      const rows = await sql`
        SELECT c.id, c.ncn, c.student_name, c.matric_number, c.course_name, 
          c.degree_type, c.grad_year, c.status, c.issued_at, c.tx_hash, c.anchored_at,
          i.name AS institution_name, i.short_code
        FROM credentials c 
        JOIN institutions i ON c.institution_id = i.id
        WHERE ${conditions}
        ORDER BY c.issued_at DESC
        LIMIT ${l} OFFSET ${offset}
      `;

      return res.status(200).json({
        credentials: rows,
        pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) }
      });
    }

    // ── POST: Search ──
    if (req.method === 'POST') {
      if (!institution && !isSuperAdmin) {
        return error(res, 'ACV_401', 'Authentication required', 401);
      }

      const { q, status: searchStatus, page, limit } = req.body;
      if (!q && !searchStatus) return error(res, 'ACV_400', 'Search query (q) or status filter required');

      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;

      let conditions = sql`1=1`;
      if (institution) conditions = sql`${conditions} AND c.institution_id = ${institution.id}`;
      if (q) conditions = sql`${conditions} AND (c.student_name ILIKE ${'%' + q + '%'} OR c.matric_number ILIKE ${'%' + q + '%'} OR c.ncn ILIKE ${'%' + q + '%'})`;
      if (searchStatus) conditions = sql`${conditions} AND c.status = ${searchStatus}`;

      const [{ count }] = await sql`SELECT COUNT(*) FROM credentials c WHERE ${conditions}`;
      const total = parseInt(count, 10);

      const rows = await sql`
        SELECT c.*, i.name AS institution_name, i.short_code
        FROM credentials c JOIN institutions i ON c.institution_id = i.id
        WHERE ${conditions}
        ORDER BY c.issued_at DESC LIMIT ${l} OFFSET ${offset}
      `;

      return res.status(200).json({
        credentials: rows,
        pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) }
      });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);

  } catch (err) {
    console.error('ACV_CREDENTIALS_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
