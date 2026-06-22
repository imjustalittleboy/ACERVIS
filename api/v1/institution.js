// ACERVIS: Single Institution Operations (v3.1.0)
// GET    /api/v1/institution?id=xxx  — Get details (auth: any)
// PUT    /api/v1/institution?id=xxx  — Update institution (auth: super admin)
// PATCH  /api/v1/institution?id=xxx&action=quota|status|reactivate — Partial update
// DELETE /api/v1/institution?id=xxx  — Deactivate (soft delete, super admin only)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { verifySuperAdmin, authenticateInstitution } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, PUT, PATCH, DELETE, OPTIONS');

  try {
    const sql = getDb();
    const id = req.query.id;

    if (!id) return error(res, 'ACV_400', 'Institution ID required');

    // ── GET: Single institution ──
    if (req.method === 'GET') {
      const [inst] = await sql`SELECT * FROM institutions WHERE id = ${id}`;
      if (!inst) return error(res, 'ACV_404', 'Institution not found', 404);

      const [stats] = await sql`
        SELECT
          (SELECT COUNT(*) FROM credentials WHERE institution_id = ${id}) AS total_credentials,
          (SELECT COUNT(*) FROM transcripts WHERE institution_id = ${id}) AS total_transcripts,
          (SELECT COUNT(*) FROM credentials WHERE institution_id = ${id} AND status = 'active') AS active_credentials,
          (SELECT COUNT(*) FROM credentials WHERE institution_id = ${id} AND status = 'revoked') AS revoked_credentials,
          (SELECT COUNT(*) FROM transcripts WHERE institution_id = ${id} AND status = 'active') AS active_transcripts,
          (SELECT COUNT(*) FROM credentials WHERE institution_id = ${id} AND issued_at > NOW() - INTERVAL '30 days') AS issued_30d
      `;

      return res.status(200).json({ ...inst, stats });
    }

    // ── PUT: Full update (super admin) ──
    if (req.method === 'PUT') {
      if (!verifySuperAdmin(req)) return error(res, 'ACV_403', 'Super Admin access required', 403);

      const { name, short_code, type, quota, email, wallet } = req.body;
      const [inst] = await sql`
        UPDATE institutions SET
          name = COALESCE(${name}, name),
          short_code = COALESCE(${short_code}, short_code),
          type = COALESCE(${type}, type),
          issuance_quota = COALESCE(${quota}, issuance_quota),
          admin_email = COALESCE(${email}, admin_email),
          wallet_address = COALESCE(${wallet}, wallet_address)
        WHERE id = ${id}
        RETURNING *
      `;

      if (!inst) return error(res, 'ACV_404', 'Institution not found', 404);

      await logAudit('institution_updated', null, id, { updates: req.body }, req);
      return res.status(200).json({ success: true, institution: inst });
    }

    // ── PATCH: Partial updates (quota, status) ──
    if (req.method === 'PATCH') {
      if (!verifySuperAdmin(req)) return error(res, 'ACV_403', 'Super Admin access required', 403);

      const { action } = req.query;

      if (action === 'quota') {
        const { quota } = req.body;
        if (!quota || quota < 0) return error(res, 'ACV_400', 'Valid quota required');

        const [inst] = await sql`
          UPDATE institutions SET issuance_quota = ${quota}, last_activity_at = NOW()
          WHERE id = ${id} RETURNING id, name, issuance_quota, issued_count
        `;
        if (!inst) return error(res, 'ACV_404', 'Institution not found', 404);

        await logAudit('quota_updated', null, id, { new_quota: quota, current_issued: inst.issued_count }, req);
        return res.status(200).json({ success: true, institution: inst });
      }

      if (action === 'status') {
        const { is_active } = req.body;
        if (typeof is_active !== 'boolean') return error(res, 'ACV_400', 'is_active (boolean) required');

        const [inst] = await sql`
          UPDATE institutions SET is_active = ${is_active}, last_activity_at = NOW()
          WHERE id = ${id} RETURNING id, name, is_active
        `;
        if (!inst) return error(res, 'ACV_404', 'Institution not found', 404);

        await logAudit(is_active ? 'institution_reactivated' : 'institution_deactivated', null, id, {}, req);
        return res.status(200).json({
          success: true,
          message: is_active ? 'Institution reactivated' : 'Institution deactivated',
          institution: inst
        });
      }

      return error(res, 'ACV_400', 'Invalid action. Use: quota, status');
    }

    // ── DELETE: Deactivate institution ──
    if (req.method === 'DELETE') {
      if (!verifySuperAdmin(req)) return error(res, 'ACV_403', 'Super Admin access required', 403);

      const [inst] = await sql`
        UPDATE institutions SET is_active = FALSE, last_activity_at = NOW()
        WHERE id = ${id} RETURNING id, name, is_active
      `;
      if (!inst) return error(res, 'ACV_404', 'Institution not found', 404);

      await logAudit('institution_deactivated', null, id, {}, req);
      return res.status(200).json({ success: true, message: 'Institution deactivated' });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);

  } catch (err) {
    console.error('ACV_INSTITUTION_ERROR:', err);
    if (err.code === '23505') return error(res, 'ACV_409', 'Duplicate value (short_code or email)', 409);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
