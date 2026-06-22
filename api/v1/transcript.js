// ACERVIS: Single Transcript Operations (v3.1.0)
// GET   /api/v1/transcript?ncn=XXXX  — Get full transcript with all subjects
// PATCH /api/v1/transcript?ncn=XXXX  — Update status (active/suspended/revoked)
// DELETE /api/v1/transcript?ncn=XXXX — Hard delete (super admin only)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, PATCH, DELETE, OPTIONS');

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);
    const { ncn } = req.query;

    if (!ncn) return error(res, 'ACV_400', 'NCN required');

    // ── GET: Full transcript with subjects ──
    if (req.method === 'GET') {
      const [transcript] = await sql`
        SELECT t.*, i.name AS institution_name, i.short_code, i.type AS institution_type
        FROM transcripts t JOIN institutions i ON t.institution_id = i.id
        WHERE t.ncn = ${ncn}
      `;

      if (!transcript) return error(res, 'ACV_404', 'Transcript not found', 404);

      // Get all subjects
      const subjects = await sql`
        SELECT * FROM transcript_subjects 
        WHERE transcript_id = ${transcript.id}
        ORDER BY session, 
          CASE semester WHEN 'First' THEN 1 WHEN 'Second' THEN 2 WHEN 'Summer' THEN 3 END,
          course_code
      `;

      // Verify integrity
      const { createHmac, createHash } = await import('crypto');
      const pepper = process.env.PROTOCOL_PEPPER;
      const subHash = createHash('sha256')
        .update(subjects.map(s => `${s.course_code}|${s.credit_units}|${s.score}|${s.grade}|${s.semester}|${s.session}`).join('||'))
        .digest('hex');
      const payload = `${transcript.student_name}|${transcript.graduation_year}|${transcript.course_name}|${transcript.degree_type}|${transcript.matric_number}|${transcript.cgpa}|${transcript.total_credits}|${subHash}`.toLowerCase();
      const localHash = createHmac('sha256', pepper).update(payload + transcript.salt).digest('hex');
      const integrityOk = localHash === transcript.blockchain_hash;

      return res.status(200).json({
        ...transcript,
        subjects,
        integrity_check: integrityOk ? 'PASSED' : 'FAILED',
        subjects_hash_match: subHash === transcript.subjects_hash,
        blockchain_status: transcript.tx_hash ? 'ANCHORED' : 'PENDING'
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

      const [trans] = await sql`SELECT * FROM transcripts WHERE ncn = ${ncn}`;
      if (!trans) return error(res, 'ACV_404', 'Transcript not found', 404);

      if (institution && trans.institution_id !== institution.id) {
        return error(res, 'ACV_403', 'Not authorized', 403);
      }

      const [updated] = await sql`
        UPDATE transcripts SET status = ${newStatus} WHERE ncn = ${ncn}
        RETURNING id, ncn, student_name, status
      `;

      await logAudit('transcript_' + newStatus, institution?.id || null, trans.id, {
        ncn, previous_status: trans.status, reason: reason || null
      }, req);

      return res.status(200).json({ success: true, transcript: updated });
    }

    // ── DELETE: Hard delete (super admin only) ──
    if (req.method === 'DELETE') {
      if (!isSuperAdmin) return error(res, 'ACV_403', 'Super Admin access required', 403);

      const [trans] = await sql`
        DELETE FROM transcripts WHERE ncn = ${ncn}
        RETURNING id, ncn, student_name
      `;
      if (!trans) return error(res, 'ACV_404', 'Transcript not found', 404);

      await logAudit('transcript_deleted', null, trans.id, { ncn }, req);
      return res.status(200).json({ success: true, message: 'Transcript permanently deleted' });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);

  } catch (err) {
    console.error('ACV_TRANSCRIPT_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
