// ACERVIS: Single Credential Operations (v3.1.0)
// GET   /api/v1/credential?ncn=XXXX  — Get full credential details
// PATCH /api/v1/credential?ncn=XXXX  — Update status (active/suspended/revoked)
//          Body: { status: "revoked", reason: "..." }
// DELETE /api/v1/credential?ncn=XXXX  — Hard delete (super admin only)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';
import { verifyIntegrity } from './_lib/crypto.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, PATCH, DELETE, OPTIONS');

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);
    const { ncn } = req.query;

    if (!ncn) return error(res, 'ACV_400', 'NCN required');

    // ── GET: Full details ──
    if (req.method === 'GET') {
      const [cred] = await sql`
        SELECT c.*, i.name AS institution_name, i.short_code, i.type AS institution_type
        FROM credentials c JOIN institutions i ON c.institution_id = i.id
        WHERE c.ncn = ${ncn}
      `;

      if (!cred) return error(res, 'ACV_404', 'Credential not found', 404);

      // Verify integrity (recompute hash)
      const payload = `${cred.student_name}|${cred.grad_year}|${cred.course_name}|${cred.degree_type}|${cred.matric_number}`.toLowerCase();
      const pepper = process.env.PROTOCOL_PEPPER;
      const { createHmac } = await import('crypto');
      const localHash = createHmac('sha256', pepper).update(payload + cred.salt).digest('hex');
      const integrityOk = localHash === cred.blockchain_hash;

      return res.status(200).json({
        ...cred,
        integrity_check: integrityOk ? 'PASSED' : 'FAILED',
        blockchain_status: cred.tx_hash ? 'ANCHORED' : 'PENDING'
      });
    }

    // ── PATCH: Update status ──
    if (req.method === 'PATCH') {
      if (!institution && !isSuperAdmin) {
        return error(res, 'ACV_401', 'Authentication required', 401);
      }

      const { status: newStatus, reason } = req.body;
      if (!['active', 'suspended', 'revoked'].includes(newStatus)) {
        return error(res, 'ACV_400', 'Status must be: active, suspended, or revoked');
      }

      // Fetch credential to check ownership
      const [cred] = await sql`SELECT * FROM credentials WHERE ncn = ${ncn}`;
      if (!cred) return error(res, 'ACV_404', 'Credential not found', 404);

      // Institution can only manage their own credentials. Super admin can manage all.
      if (institution && cred.institution_id !== institution.id) {
        return error(res, 'ACV_403', 'Not authorized to manage this credential', 403);
      }

      const [updated] = await sql`
        UPDATE credentials SET status = ${newStatus} WHERE ncn = ${ncn}
        RETURNING id, ncn, student_name, status
      `;

      // ONE-DIRECTIONAL REVOCATION: Revoking a credential also revokes linked transcripts
      if (newStatus === 'revoked') {
        const transcriptResult = await sql`
          UPDATE transcripts SET status = 'revoked'
          WHERE linked_credential_id = ${cred.id} AND status != 'revoked'
          RETURNING ncn
        `;
        if (transcriptResult.length > 0) {
          await logAudit('linked_transcripts_revoked', institution?.id || null, cred.id, {
            credential_ncn: ncn,
            transcript_ncns: transcriptResult.map(t => t.ncn),
            reason: reason || 'Credential revoked'
          }, req);
        }
      }

      await logAudit('credential_' + newStatus, institution?.id || null, cred.id, {
        ncn, previous_status: cred.status, reason: reason || null
      }, req);

      return res.status(200).json({
        success: true,
        credential: updated,
        linked_transcripts_affected: newStatus === 'revoked'
      });
    }

    // ── DELETE: Hard delete (super admin only) ──
    if (req.method === 'DELETE') {
      if (!isSuperAdmin) return error(res, 'ACV_403', 'Super Admin access required', 403);

      const [cred] = await sql`
        DELETE FROM credentials WHERE ncn = ${ncn}
        RETURNING id, ncn, student_name
      `;
      if (!cred) return error(res, 'ACV_404', 'Credential not found', 404);

      await logAudit('credential_deleted', null, cred.id, { ncn }, req);
      return res.status(200).json({ success: true, message: 'Credential permanently deleted' });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);

  } catch (err) {
    console.error('ACV_CREDENTIAL_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
