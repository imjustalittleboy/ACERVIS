// ACERVIS: Credential Management (Consolidated v3.1.0)
// GET   /api/v1/credentials          — List with filters (institution or super admin)
// POST  /api/v1/credentials          — Search by name/matric/NCN
// GET   /api/v1/credentials?ncn=X    — Single credential full details + integrity check
// PATCH /api/v1/credentials?ncn=X    — Update status (active/suspended/revoked)
// DELETE/api/v1/credentials?ncn=X    — Hard delete (super admin only)
// Body variants for bulk:
// POST  /api/v1/credentials          — With { action: "bulk-status", ncns: [...], status: "revoked" }
// POST  /api/v1/credentials          — With raw CSV body (ncn column) for bulk status
import Papa from 'papaparse';
import { handlePreflight, error } from './_lib/cors.js';
import { getDb, frag } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, POST, PATCH, DELETE, OPTIONS');

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);

    // ── GET: List or Single ──
    if (req.method === 'GET') {
      const { ncn, page, limit, status, search, institution_id, from, to } = req.query;

      // Single credential by NCN
      if (ncn) {
        const [cred] = await sql`
          SELECT c.*, i.name AS institution_name, i.short_code, i.type AS institution_type
          FROM credentials c JOIN institutions i ON c.institution_id = i.id WHERE c.ncn = ${ncn}
        `;
        if (!cred) return error(res, 'ACV_404', 'Credential not found', 404);

        // Integrity check
        const { createHmac } = await import('crypto');
        const payload = `${cred.student_name}|${cred.grad_year}|${cred.course_name}|${cred.degree_type}|${cred.matric_number}`.toLowerCase();
        const localHash = createHmac('sha256', process.env.PROTOCOL_PEPPER).update(payload + cred.salt).digest('hex');
        return res.status(200).json({ ...cred, integrity_check: localHash === cred.blockchain_hash ? 'PASSED' : 'FAILED', blockchain_status: cred.tx_hash ? 'ANCHORED' : 'PENDING' });
      }

      // List with filters
      const instId = institution ? institution.id : (isSuperAdmin && institution_id ? institution_id : null);
      if (!instId) return error(res, 'ACV_401', 'Authentication required', 401);

      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;

      let conditions = frag`c.institution_id = ${instId}`;
      if (status) conditions = frag`${conditions} AND c.status = ${status}`;
      if (search) conditions = frag`${conditions} AND (c.student_name ILIKE ${'%' + search + '%'} OR c.matric_number ILIKE ${'%' + search + '%'} OR c.ncn ILIKE ${'%' + search + '%'})`;

      const [{ count }] = await sql`SELECT COUNT(*) FROM credentials c WHERE ${conditions}`;
      const rows = await sql`
        SELECT c.id,c.ncn,c.student_name,c.matric_number,c.course_name,c.degree_type,c.grad_year,c.status,c.issued_at,c.tx_hash,c.anchored_at, i.name AS institution_name,i.short_code
        FROM credentials c JOIN institutions i ON c.institution_id = i.id
        WHERE ${conditions} ORDER BY c.issued_at DESC LIMIT ${l} OFFSET ${offset}
      `;
      return res.status(200).json({ credentials: rows, pagination: { page: p, limit: l, total: parseInt(count, 10), totalPages: Math.ceil(parseInt(count, 10) / l) } });
    }

    // ── POST: Search OR Bulk-Status ──
    if (req.method === 'POST') {
      if (!institution && !isSuperAdmin) return error(res, 'ACV_401', 'Authentication required', 401);

      // Bulk status (JSON: { ncns: [...], status: "revoked" } OR raw CSV with ncn column)
      if (req.body?.ncns || typeof req.body === 'string' || req.body?.csv) {
        let ncns = [], reason = '';
        if (typeof req.body === 'string') {
          const parsed = Papa.parse(req.body.trim(), { header: true, skipEmptyLines: true });
          ncns = parsed.data.map(r => (r.ncn||'').trim()).filter(Boolean);
        } else if (req.body.ncns) {
          ncns = Array.isArray(req.body.ncns) ? req.body.ncns : [req.body.ncns];
          reason = req.body.reason || '';
        } else if (req.body.csv) {
          const parsed = Papa.parse(req.body.csv.trim(), { header: true, skipEmptyLines: true });
          ncns = parsed.data.map(r => (r.ncn||'').trim()).filter(Boolean);
        }

        const newStatus = req.body?.status || 'revoked';
        if (!['active','suspended','revoked'].includes(newStatus)) return error(res, 'ACV_400', 'Status must be: active, suspended, revoked');
        if (!ncns.length) return error(res, 'ACV_400', 'No NCNs provided');
        if (ncns.length > 1000) return error(res, 'ACV_400', 'Max 1000 NCNs per batch');

        const processed = [];
        for (const ncn of ncns) {
          try {
            const [cred] = await sql`SELECT id,institution_id,status,ncn FROM credentials WHERE ncn=${ncn}`;
            if (!cred) { processed.push({ ncn, status:'error', error:'Not found' }); continue; }
            if (institution && cred.institution_id !== institution.id) { processed.push({ ncn, status:'error', error:'Not authorized' }); continue; }
            if (cred.status === newStatus) { processed.push({ ncn, status:'skipped', message:`Already ${newStatus}` }); continue; }
            await sql`UPDATE credentials SET status=${newStatus} WHERE ncn=${ncn}`;
            // One-directional revocation cascade
            if (newStatus === 'revoked') await sql`UPDATE transcripts SET status='revoked' WHERE linked_credential_id=${cred.id} AND status!='revoked'`;
            processed.push({ ncn, status: newStatus, previous: cred.status });
          } catch (e) { processed.push({ ncn, status:'error', error: e.message }); }
        }

        await logAudit('bulk_credential_' + newStatus, institution?.id||null, null, { count: processed.filter(p=>p.status===newStatus).length, total: ncns.length }, req);
        return res.status(200).json({ success: true, summary: { total: ncns.length, updated: processed.filter(p=>p.status===newStatus).length, skipped: processed.filter(p=>p.status==='skipped').length, errors: processed.filter(p=>p.status==='error').length }, results: processed });
      }

      // Search
      const { q, status: s, page, limit } = req.body;
      if (!q && !s) return error(res, 'ACV_400', 'Search query or status filter required');
      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;

      let cond = frag`TRUE`;
      if (institution) cond = frag`${cond} AND c.institution_id = ${institution.id}`;
      if (q) cond = frag`${cond} AND (c.student_name ILIKE ${'%' + q + '%'} OR c.matric_number ILIKE ${'%' + q + '%'} OR c.ncn ILIKE ${'%' + q + '%'})`;
      if (s) cond = frag`${cond} AND c.status = ${s}`;
      const [{ count: total }] = await sql`SELECT COUNT(*) FROM credentials c WHERE ${cond}`;
      const rows = await sql`SELECT c.*, i.name AS institution_name,i.short_code FROM credentials c JOIN institutions i ON c.institution_id=i.id WHERE ${cond} ORDER BY c.issued_at DESC LIMIT ${l} OFFSET ${offset}`;
      return res.status(200).json({ credentials: rows, pagination: { page: p, limit: l, total: parseInt(total, 10), totalPages: Math.ceil(parseInt(total, 10) / l) } });
    }

    // ── PATCH: Update Status ──
    if (req.method === 'PATCH') {
      if (!institution && !isSuperAdmin) return error(res, 'ACV_401', 'Auth required', 401);
      const { ncn } = req.query;
      if (!ncn) return error(res, 'ACV_400', 'NCN required');
      const { status: newStatus, reason } = req.body;
      if (!['active','suspended','revoked'].includes(newStatus)) return error(res, 'ACV_400', 'Status must be: active, suspended, revoked');

      const [cred] = await sql`SELECT * FROM credentials WHERE ncn=${ncn}`;
      if (!cred) return error(res, 'ACV_404', 'Not found', 404);
      if (institution && cred.institution_id !== institution.id) return error(res, 'ACV_403', 'Not authorized', 403);

      const [updated] = await sql`UPDATE credentials SET status=${newStatus} WHERE ncn=${ncn} RETURNING id,ncn,student_name,status`;

      // Cascade to linked transcripts on revocation
      if (newStatus === 'revoked') {
        const linked = await sql`UPDATE transcripts SET status='revoked' WHERE linked_credential_id=${cred.id} AND status!='revoked' RETURNING ncn`;
        if (linked.length) await logAudit('linked_transcripts_revoked', institution?.id||null, cred.id, { credential_ncn: ncn, transcript_ncns: linked.map(t=>t.ncn) }, req);
      }

      await logAudit('credential_' + newStatus, institution?.id||null, cred.id, { ncn, previous_status: cred.status }, req);
      return res.status(200).json({ success: true, credential: updated, linked_transcripts_affected: newStatus === 'revoked' });
    }

    // ── DELETE: Hard Delete ──
    if (req.method === 'DELETE') {
      if (!isSuperAdmin) return error(res, 'ACV_403', 'Super Admin access required', 403);
      const { ncn } = req.query;
      if (!ncn) return error(res, 'ACV_400', 'NCN required');
      const [cred] = await sql`DELETE FROM credentials WHERE ncn=${ncn} RETURNING id,ncn,student_name`;
      if (!cred) return error(res, 'ACV_404', 'Not found', 404);
      await logAudit('credential_deleted', null, cred.id, { ncn }, req);
      return res.status(200).json({ success: true, message: 'Credential deleted' });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);
  } catch (err) {
    console.error('ACV_CRED_ERROR:', err.message, err.stack?.slice(0, 300));
    return error(res, 'ACV_500', err.message || 'Internal server error', 500);
  }
}
