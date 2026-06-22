// ACERVIS: Bulk Transcript Status Update (v3.1.0)
// POST /api/v1/bulk-transcript-status
// Body: { ncns: [...], status: "revoked" } or raw CSV with ncn column
import Papa from 'papaparse';
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';

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

    let ncns = [];
    let reason = '';

    if (typeof req.body === 'string') {
      const parsed = Papa.parse(req.body.trim(), { header: true, skipEmptyLines: true });
      ncns = parsed.data.map(r => (r.ncn || '').trim()).filter(Boolean);
    } else if (req.body?.ncns) {
      ncns = Array.isArray(req.body.ncns) ? req.body.ncns : [req.body.ncns];
      reason = req.body.reason || '';
    } else if (req.body?.csv) {
      const parsed = Papa.parse(req.body.csv.trim(), { header: true, skipEmptyLines: true });
      ncns = parsed.data.map(r => (r.ncn || '').trim()).filter(Boolean);
    } else {
      return error(res, 'ACV_400', 'Send { ncns: [...], status: "..." } or raw CSV with ncn column');
    }

    const newStatus = req.body?.status || 'revoked';
    if (!['active', 'suspended', 'revoked'].includes(newStatus)) {
      return error(res, 'ACV_400', 'Status must be: active, suspended, or revoked');
    }

    if (ncns.length === 0) return error(res, 'ACV_400', 'No NCNs provided');
    if (ncns.length > 1000) return error(res, 'ACV_400', 'Maximum 1000 NCNs per batch');

    const processed = [];

    for (const ncn of ncns) {
      try {
        const [trans] = await sql`SELECT id, institution_id, status, ncn FROM transcripts WHERE ncn = ${ncn}`;
        if (!trans) {
          processed.push({ ncn, status: 'error', error: 'Not found' });
          continue;
        }

        if (institution && trans.institution_id !== institution.id) {
          processed.push({ ncn, status: 'error', error: 'Not authorized' });
          continue;
        }

        if (trans.status === newStatus) {
          processed.push({ ncn, status: 'skipped', message: `Already ${newStatus}` });
          continue;
        }

        await sql`UPDATE transcripts SET status = ${newStatus} WHERE ncn = ${ncn}`;
        processed.push({ ncn, status: newStatus, previous: trans.status });
      } catch (err) {
        processed.push({ ncn, status: 'error', error: err.message });
      }
    }

    await logAudit('bulk_transcript_' + newStatus, institution?.id || null, null, {
      count: processed.filter(p => p.status === newStatus).length,
      total: ncns.length, reason: reason || null
    }, req);

    return res.status(200).json({
      success: true,
      summary: {
        total: ncns.length,
        updated: processed.filter(p => p.status === newStatus).length,
        skipped: processed.filter(p => p.status === 'skipped').length,
        errors: processed.filter(p => p.status === 'error').length
      },
      results: processed
    });

  } catch (err) {
    console.error('ACV_BULK_TRANS_STATUS_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
