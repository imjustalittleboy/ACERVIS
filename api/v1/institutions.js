// ACERVIS: Institution Management API (v3.1.0)
// GET  /api/v1/institutions        — List all (super admin)
// POST /api/v1/institutions        — Onboard new (super admin) — mirrors onboard.js for convenience
// GET  /api/v1/institutions?id=xxx — Get single institution details + stats
import { randomBytes } from 'crypto';
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { verifySuperAdmin, authenticateInstitution } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, POST, OPTIONS');

  try {
    const sql = getDb();

    // ── GET: List or Single ──
    if (req.method === 'GET') {
      const { id, page, limit, search, status } = req.query;

      if (id) {
        // Single institution details with stats
        const [inst] = await sql`
          SELECT i.*,
            (SELECT COUNT(*) FROM credentials WHERE institution_id = i.id) AS credentials_count,
            (SELECT COUNT(*) FROM transcripts WHERE institution_id = i.id) AS transcripts_count,
            (SELECT COUNT(*) FROM credentials WHERE institution_id = i.id AND status = 'active') AS active_count,
            (SELECT COUNT(*) FROM credentials WHERE institution_id = i.id AND status = 'revoked') AS revoked_count
          FROM institutions i WHERE i.id = ${id}
        `;

        if (!inst) return error(res, 'ACV_404', 'Institution not found', 404);

        // Get recent activity
        const recentActivity = await sql`
          SELECT action, metadata, created_at FROM audit_logs 
          WHERE actor_id = ${id} ORDER BY created_at DESC LIMIT 10
        `;

        // Get monthly issuance trend (last 6 months)
        const monthlyTrend = await sql`
          SELECT DATE_TRUNC('month', issued_at) AS month, COUNT(*) AS count
          FROM credentials WHERE institution_id = ${id}
            AND issued_at > NOW() - INTERVAL '6 months'
          GROUP BY month ORDER BY month
        `;

        return res.status(200).json({
          ...inst,
          recent_activity: recentActivity,
          monthly_trend: monthlyTrend
        });
      }

      // List institutions with filters
      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;

      let where = sql`TRUE`;
      if (search) where = sql`${where} AND (i.name ILIKE ${'%' + search + '%'} OR i.short_code ILIKE ${'%' + search + '%'})`;
      if (status === 'active') where = sql`${where} AND i.is_active = TRUE`;
      if (status === 'inactive') where = sql`${where} AND i.is_active = FALSE`;

      const [{ count }] = await sql`SELECT COUNT(*) FROM institutions i WHERE ${where}`;
      const total = parseInt(count, 10);

      const rows = await sql`
        SELECT i.*,
          (SELECT COUNT(*) FROM credentials WHERE institution_id = i.id) AS credentials_count,
          (SELECT COUNT(*) FROM transcripts WHERE institution_id = i.id) AS transcripts_count
        FROM institutions i WHERE ${where}
        ORDER BY i.created_at DESC LIMIT ${l} OFFSET ${offset}
      `;

      return res.status(200).json({
        institutions: rows,
        pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) }
      });
    }

    // ── POST: Onboard new institution (super admin only) ──
    if (req.method === 'POST') {
      if (!verifySuperAdmin(req)) {
        return error(res, 'ACV_403', 'Unauthorized Governance Action', 403);
      }

      const { name, short_code, type, quota, email, wallet } = req.body;
      if (!name || !short_code || !type || !quota || !email) {
        return error(res, 'ACV_400', 'Required: name, short_code, type, quota, email');
      }

      const token = randomBytes(6).toString('hex').toUpperCase();

      const [institution] = await sql`
        INSERT INTO institutions (name, short_code, type, token_id, issuance_quota, admin_email, wallet_address)
        VALUES (${name}, ${short_code.toUpperCase()}, ${type}, ${token}, ${quota}, ${email}, ${wallet || null})
        RETURNING id, token_id, name AS institution_name
      `;

      await logAudit('institution_onboarded', null, institution.id, {
        name, short_code, type, quota
      }, req);

      return res.status(201).json({
        success: true,
        institution_id: institution.id,
        token_id: institution.token_id,
        message: 'Institution onboarded. Share the Token ID with the registrar.'
      });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);

  } catch (err) {
    console.error('ACV_INSTITUTIONS_ERROR:', err);
    if (err.code === '23505') {
      if (err.message?.includes('short_code')) return error(res, 'ACV_409', 'Short Code already exists', 409);
      return error(res, 'ACV_409', 'Institution already exists', 409);
    }
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
