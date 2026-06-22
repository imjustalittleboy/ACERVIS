// ACERVIS: Global Search API (v3.1.0)
// POST /api/v1/search
// Body: { q: "search term", type: "all"|"credentials"|"transcripts", page: 1, limit: 10 }
import { handlePreflight, error } from './_lib/cors.js';
import { getDb, exec } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'POST, OPTIONS');

  if (req.method !== 'POST') return error(res, 'ACV_405', 'Method not allowed', 405);

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);

    if (!institution && !isSuperAdmin) {
      return error(res, 'ACV_401', 'Authentication required', 401);
    }

    const { q, type, page, limit } = req.body;
    if (!q || q.trim().length < 2) return error(res, 'ACV_400', 'Search query must be at least 2 characters');

    const p = parseInt(page, 10) || 1;
    const l = Math.min(parseInt(limit, 10) || 10, 50);
    const offset = (p - 1) * l;
    const searchTerm = '%' + q.trim() + '%';
    const scope = type || 'all';

    const results = {};

    // Search credentials
    if (scope === 'all' || scope === 'credentials') {
      const cclauses = [`(c.student_name ILIKE $1 OR c.matric_number ILIKE $2 OR c.ncn ILIKE $3)`];
      const cparams = [searchTerm, searchTerm, searchTerm];
      if (institution) { cclauses.push(`c.institution_id = $${cparams.length + 1}`); cparams.push(institution.id); }
      const cwhere = cclauses.join(' AND ');

      const credRows = await exec(sql,
        `SELECT c.ncn, c.student_name, c.matric_number, c.course_name, c.degree_type, c.grad_year, c.status,
          i.name AS institution_name, i.short_code
        FROM credentials c JOIN institutions i ON c.institution_id = i.id
        WHERE ${cwhere} ORDER BY c.issued_at DESC LIMIT ${l} OFFSET ${offset}`,
        cparams
      );
      results.credentials = { total: credRows.length, results: credRows };
    }

    // Search transcripts
    if (scope === 'all' || scope === 'transcripts') {
      const tclauses = [`(t.student_name ILIKE $1 OR t.matric_number ILIKE $2 OR t.ncn ILIKE $3)`];
      const tparams = [searchTerm, searchTerm, searchTerm];
      if (institution) { tclauses.push(`t.institution_id = $${tparams.length + 1}`); tparams.push(institution.id); }
      const twhere = tclauses.join(' AND ');

      const transRows = await exec(sql,
        `SELECT t.ncn, t.student_name, t.matric_number, t.course_name, t.degree_type, t.graduation_year, t.cgpa, t.status,
          (SELECT COUNT(*) FROM transcript_subjects WHERE transcript_id = t.id) AS subjects_count,
          i.name AS institution_name, i.short_code
        FROM transcripts t JOIN institutions i ON t.institution_id = i.id
        WHERE ${twhere} ORDER BY t.issued_at DESC LIMIT ${l} OFFSET ${offset}`,
        tparams
      );
      results.transcripts = { total: transRows.length, results: transRows };
    }

    // Search institutions (super admin only)
    if (isSuperAdmin && (scope === 'all' || scope === 'institutions')) {
      const instRows = await sql`
        SELECT id, name, short_code, type, issuance_quota, issued_count, is_active
        FROM institutions
        WHERE name ILIKE ${searchTerm} OR short_code ILIKE ${searchTerm}
        LIMIT ${l}
      `;
      results.institutions = { total: instRows.length, results: instRows };
    }

    return res.status(200).json({
      success: true,
      query: q.trim(),
      page: p,
      limit: l,
      ...results
    });

  } catch (err) {
    console.error('ACV_SEARCH_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
