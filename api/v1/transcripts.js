// ACERVIS: Transcript Management API (v3.1.0)
// GET  /api/v1/transcripts          — List with filters (institution admin or super admin)
// POST /api/v1/transcripts          — Search by name/matric (institution admin)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, POST, OPTIONS');

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);

    // ── GET: List with filters ──
    if (req.method === 'GET') {
      const { page, limit, status, search, institution_id, from, to } = req.query;

      const instId = institution ? institution.id : (isSuperAdmin && institution_id ? institution_id : null);
      if (!instId) return error(res, 'ACV_401', 'Authentication required', 401);

      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;

      let conditions = sql`t.institution_id = ${instId}`;
      if (status) conditions = sql`${conditions} AND t.status = ${status}`;
      if (search) conditions = sql`${conditions} AND (t.student_name ILIKE ${'%' + search + '%'} OR t.matric_number ILIKE ${'%' + search + '%'} OR t.ncn ILIKE ${'%' + search + '%'})`;
      if (from) conditions = sql`${conditions} AND t.issued_at >= ${from}`;
      if (to) conditions = sql`${conditions} AND t.issued_at <= ${to}`;

      const [{ count }] = await sql`SELECT COUNT(*) FROM transcripts t WHERE ${conditions}`;
      const total = parseInt(count, 10);

      const rows = await sql`
        SELECT t.id, t.ncn, t.student_name, t.matric_number, t.course_name,
          t.degree_type, t.graduation_year, t.cgpa, t.total_credits,
          t.status, t.issued_at, t.tx_hash, t.anchored_at,
          (SELECT COUNT(*) FROM transcript_subjects WHERE transcript_id = t.id) AS subjects_count,
          i.name AS institution_name, i.short_code
        FROM transcripts t
        JOIN institutions i ON t.institution_id = i.id
        WHERE ${conditions}
        ORDER BY t.issued_at DESC
        LIMIT ${l} OFFSET ${offset}
      `;

      return res.status(200).json({
        transcripts: rows,
        pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) }
      });
    }

    // ── POST: Search ──
    if (req.method === 'POST') {
      if (!institution && !isSuperAdmin) {
        return error(res, 'ACV_401', 'Authentication required', 401);
      }

      const { q, status: searchStatus, page, limit } = req.body;
      if (!q && !searchStatus) return error(res, 'ACV_400', 'Search query or status required');

      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;

      let conditions = sql`1=1`;
      if (institution) conditions = sql`${conditions} AND t.institution_id = ${institution.id}`;
      if (q) conditions = sql`${conditions} AND (t.student_name ILIKE ${'%' + q + '%'} OR t.matric_number ILIKE ${'%' + q + '%'} OR t.ncn ILIKE ${'%' + q + '%'})`;
      if (searchStatus) conditions = sql`${conditions} AND t.status = ${searchStatus}`;

      const [{ count }] = await sql`SELECT COUNT(*) FROM transcripts t WHERE ${conditions}`;
      const total = parseInt(count, 10);

      const rows = await sql`
        SELECT t.*, 
          (SELECT COUNT(*) FROM transcript_subjects WHERE transcript_id = t.id) AS subjects_count,
          i.name AS institution_name, i.short_code
        FROM transcripts t JOIN institutions i ON t.institution_id = i.id
        WHERE ${conditions}
        ORDER BY t.issued_at DESC LIMIT ${l} OFFSET ${offset}
      `;

      return res.status(200).json({
        transcripts: rows,
        pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) }
      });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);

  } catch (err) {
    console.error('ACV_TRANSCRIPTS_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
