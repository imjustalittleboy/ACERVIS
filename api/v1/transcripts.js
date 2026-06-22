// ACERVIS: Transcript Management (Consolidated v3.1.0)
// GET   /api/v1/transcripts          — List with filters
// GET   /api/v1/transcripts?ncn=X    — Single transcript with all subjects + integrity check
// POST  /api/v1/transcripts          — Search OR bulk status
// PATCH /api/v1/transcripts?ncn=X    — Update status
// DELETE/api/v1/transcripts?ncn=X    — Hard delete (super admin only)
import Papa from 'papaparse';
import { handlePreflight, error } from './_lib/cors.js';
import { getDb, where } from './_lib/db.js';
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

      // Single transcript by NCN
      if (ncn) {
        const [transcript] = await sql`
          SELECT t.*, i.name AS institution_name, i.short_code, i.type AS institution_type
          FROM transcripts t JOIN institutions i ON t.institution_id = i.id WHERE t.ncn = ${ncn}
        `;
        if (!transcript) return error(res, 'ACV_404', 'Transcript not found', 404);

        const subjects = await sql`
          SELECT * FROM transcript_subjects WHERE transcript_id = ${transcript.id}
          ORDER BY session, CASE semester WHEN 'First' THEN 1 WHEN 'Second' THEN 2 WHEN 'Summer' THEN 3 END, course_code
        `;

        const { createHmac, createHash } = await import('crypto');
        const pepper = process.env.PROTOCOL_PEPPER;
        const subHash = createHash('sha256')
          .update(subjects.map(s => `${s.course_code}|${s.credit_units}|${s.score}|${s.grade}|${s.semester}|${s.session}`).join('||'))
          .digest('hex');
        const payload = `${transcript.student_name}|${transcript.graduation_year}|${transcript.course_name}|${transcript.degree_type}|${transcript.matric_number}|${transcript.cgpa}|${transcript.total_credits}|${subHash}`.toLowerCase();
        const localHash = createHmac('sha256', pepper).update(payload + transcript.salt).digest('hex');
        const integrityOk = localHash === transcript.blockchain_hash;

        return res.status(200).json({
          ...transcript, subjects,
          integrity_check: integrityOk ? 'PASSED' : 'FAILED',
          subjects_hash_match: subHash === transcript.subjects_hash,
          blockchain_status: transcript.tx_hash ? 'ANCHORED' : 'PENDING'
        });
      }

      const instId = institution ? institution.id : (isSuperAdmin && institution_id ? institution_id : null);
      if (!instId) return error(res, 'ACV_401', 'Auth required', 401);

      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;
      const tCond = { 't.institution_id': instId };
      if (status) tCond['t.status'] = status;
      if (search) {
        const s = `%${search}%`;
        tCond['_raw'] = { sql: `(t.student_name ILIKE $1 OR t.matric_number ILIKE $2 OR t.ncn ILIKE $3)`, params: [s, s, s] };
      }
      const w = where(tCond);
      const tw = w.text ? `WHERE ${w.text}` : '';
      const tBase = `FROM transcripts t JOIN institutions i ON t.institution_id=i.id`;

      const [{ count }] = await sql.unsafe(`SELECT COUNT(*) ${tBase} ${tw}`, w.params);
      const rows = await sql.unsafe(
        `SELECT t.id,t.ncn,t.student_name,t.matric_number,t.course_name,t.degree_type,t.graduation_year,t.cgpa,t.total_credits,t.status,t.issued_at,t.tx_hash,t.anchored_at,
          (SELECT COUNT(*) FROM transcript_subjects WHERE transcript_id=t.id) AS subjects_count,
          i.name AS institution_name,i.short_code ${tBase} ${tw} ORDER BY t.issued_at DESC LIMIT ${l} OFFSET ${offset}`,
        w.params
      );
      return res.status(200).json({ transcripts: rows, pagination: { page: p, limit: l, total: parseInt(count, 10), totalPages: Math.ceil(parseInt(count, 10) / l) } });
    }

    // ── POST: Search or Bulk-Status ──
    if (req.method === 'POST') {
      if (!institution && !isSuperAdmin) return error(res, 'ACV_401', 'Auth required', 401);

      // Bulk status
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
        if (!ncns.length) return error(res, 'ACV_400', 'No NCNs');
        if (ncns.length > 1000) return error(res, 'ACV_400', 'Max 1000');

        const processed = [];
        for (const ncn of ncns) {
          try {
            const [t] = await sql`SELECT id,institution_id,status,ncn FROM transcripts WHERE ncn=${ncn}`;
            if (!t) { processed.push({ ncn, status:'error', error:'Not found' }); continue; }
            if (institution && t.institution_id !== institution.id) { processed.push({ ncn, status:'error', error:'Not authorized' }); continue; }
            if (t.status === newStatus) { processed.push({ ncn, status:'skipped' }); continue; }
            await sql`UPDATE transcripts SET status=${newStatus} WHERE ncn=${ncn}`;
            processed.push({ ncn, status: newStatus, previous: t.status });
          } catch (e) { processed.push({ ncn, status:'error', error: e.message }); }
        }
        await logAudit('bulk_transcript_' + newStatus, institution?.id||null, null, { count: processed.filter(p=>p.status===newStatus).length, total: ncns.length }, req);
        return res.status(200).json({ success: true, summary: { total: ncns.length, updated: processed.filter(p=>p.status===newStatus).length, skipped: processed.filter(p=>p.status==='skipped').length, errors: processed.filter(p=>p.status==='error').length }, results: processed });
      }

      // Search
      const { q, status: s, page, limit } = req.body;
      if (!q && !s) return error(res, 'ACV_400', 'Query or status required');
      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;

      const searchCond = {};
      if (institution) searchCond['t.institution_id'] = institution.id;
      if (s) searchCond['t.status'] = s;
      if (q) {
        const sq = `%${q}%`;
        searchCond['_raw'] = { sql: `(t.student_name ILIKE $1 OR t.matric_number ILIKE $2 OR t.ncn ILIKE $3)`, params: [sq, sq, sq] };
      }
      const w2 = where(searchCond);
      const wc2 = w2.text ? `WHERE ${w2.text}` : '';

      const [{ count: total }] = await sql.unsafe(`SELECT COUNT(*) FROM transcripts t WHERE ${w2.text || 'TRUE'}`, w2.params);
      const rows = await sql.unsafe(
        `SELECT t.*, (SELECT COUNT(*) FROM transcript_subjects WHERE transcript_id=t.id) AS subjects_count, i.name AS institution_name,i.short_code
        FROM transcripts t JOIN institutions i ON t.institution_id=i.id ${wc2} ORDER BY t.issued_at DESC LIMIT ${l} OFFSET ${offset}`,
        w2.params
      );
      return res.status(200).json({ transcripts: rows, pagination: { page: p, limit: l, total: parseInt(total, 10), totalPages: Math.ceil(parseInt(total, 10) / l) } });
    }

    // ── PATCH: Update Status ──
    if (req.method === 'PATCH') {
      if (!institution && !isSuperAdmin) return error(res, 'ACV_401', 'Auth required', 401);
      const { ncn } = req.query;
      if (!ncn) return error(res, 'ACV_400', 'NCN required');
      const { status: newStatus, reason } = req.body;
      if (!['active','suspended','revoked'].includes(newStatus)) return error(res, 'ACV_400', 'Status must be: active, suspended, revoked');

      const [t] = await sql`SELECT * FROM transcripts WHERE ncn=${ncn}`;
      if (!t) return error(res, 'ACV_404', 'Not found', 404);
      if (institution && t.institution_id !== institution.id) return error(res, 'ACV_403', 'Not authorized', 403);

      const [updated] = await sql`UPDATE transcripts SET status=${newStatus} WHERE ncn=${ncn} RETURNING id,ncn,student_name,status`;
      await logAudit('transcript_' + newStatus, institution?.id||null, t.id, { ncn, previous_status: t.status }, req);
      return res.status(200).json({ success: true, transcript: updated });
    }

    // ── DELETE: Hard Delete ──
    if (req.method === 'DELETE') {
      if (!isSuperAdmin) return error(res, 'ACV_403', 'Super Admin required', 403);
      const { ncn } = req.query;
      if (!ncn) return error(res, 'ACV_400', 'NCN required');
      const [t] = await sql`DELETE FROM transcripts WHERE ncn=${ncn} RETURNING id,ncn,student_name`;
      if (!t) return error(res, 'ACV_404', 'Not found', 404);
      await logAudit('transcript_deleted', null, t.id, { ncn }, req);
      return res.status(200).json({ success: true, message: 'Transcript deleted' });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);
  } catch (err) {
    console.error('ACV_TRANS_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
