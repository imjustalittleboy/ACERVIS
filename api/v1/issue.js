// ACERVIS: Batch Issuance (Consolidated v3.1.0)
// Handles credential-only batch AND combined CSV (credential + transcript with subjects).
// Accepts: JSON { batch } with x-institution-token header, or raw CSV body.
// Auto-detects format: if CSV has 'type' column with STUDENT/SUBJECT markers → combined.
// Otherwise → credential-only.
import { createHmac, createHash, randomBytes } from 'crypto';
import Papa from 'papaparse';
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';
import { walletFromInstitution } from './_lib/crypto.js';

// ─── Helpers ──────────────────────────────────────────────

function hashPayload(pepper, payload, salt) {
  if (!pepper) throw new Error('PROTOCOL_PEPPER environment variable is not configured. Add it in Vercel → Settings → Environment Variables.');
  return createHmac('sha256', pepper).update(payload + salt).digest('hex');
}

function salt() { return randomBytes(16).toString('hex'); }

function randHex(n = 4) { return randomBytes(n).toString('hex').toUpperCase(); }

function credNcn(sc, y) { return `${sc}-${y}-${randHex()}`; }

function transNcn(sc, y) { return `${sc}-T-${y}-${randHex()}`; }

function credPayload(n, y, c, d, m) { return `${n}|${y}|${c}|${d}|${m}`.toLowerCase(); }

function transPayload(n, y, c, d, m, g, cr, sh) {
  return `${n}|${y}|${c}|${d}|${m}|${g}|${cr}|${sh}`.toLowerCase();
}

function subjectHash(subjects) {
  const s = subjects.map(x => `${x.code}|${x.credits}|${x.score}|${x.grade}|${x.sem}|${x.ses}`).join('||');
  return createHash('sha256').update(s).digest('hex');
}

async function anchorHash(hash, wallet) {
  if (!process.env.CONTRACT_ADDRESS || !process.env.ALCHEMY_RPC_URL || !wallet) return null;
  try {
    const { ethers } = await import('ethers');
    const c = new ethers.Contract(process.env.CONTRACT_ADDRESS,
      ['function anchorCredential(bytes32) external'], wallet);
    const tx = await c.anchorCredential('0x' + hash);
    const r = await tx.wait();
    return { txHash: r.hash };
  } catch (e) {
    console.error('ANCHOR_ERR:', e.message);
    let reason = e.reason || e.message;
    if (e.code === 'INSUFFICIENT_FUNDS') reason = 'Insufficient POL for gas. Fund this wallet using Super Admin → Fund Gas.';
    else if (e.reason?.includes('Unauthorized')) reason = 'Wallet not authorized on smart contract. Authorize via Super Admin → Blockchain.';
    return { error: reason };
  }
}

// ─── Credential-Only ──────────────────────────────────────

async function processCredentials(sql, inst, rows, pepper, wallet) {
  const results = [], errors = [];
  for (const r of rows) {
    try {
      const n = (r.student_name || r.name || '').trim();
      const m = (r.matric_number || r.matric || '').trim();
      const y = parseInt(r.graduation_year || r.grad_year || r.year, 10);
      const c = (r.course_name || r.course || '').trim();
      const d = (r.degree_type || r.type || '').trim();
      if (!n || !m || !y || !c || !d) { errors.push({ row: n || '?', error: 'Missing fields', fields: { name: n, matric: m, year: y, course: c, degree: d } }); continue; }

      const slt = salt();
      const h = hashPayload(pepper, credPayload(n, y, c, d, m), slt);
      const ncn = credNcn(inst.short_code, y);
      await sql`INSERT INTO credentials (institution_id,ncn,student_name,matric_number,grad_year,course_name,degree_type,salt,blockchain_hash)
        VALUES (${inst.id},${ncn},${n},${m},${y},${c},${d},${slt},${h})`;
      results.push({ ncn, hash: h, student_name: n, matric_number: m, type: 'credential' });
    } catch (e) { errors.push({ row: r.student_name || '?', error: e.message }); }
  }
  let txHashes = [];
  let anchorErrors = [];
  if (results.length && process.env.CONTRACT_ADDRESS && wallet) {
    for (const r of results) {
      const result = await anchorHash(r.hash, wallet);
      if (result?.txHash) {
        txHashes.push({ ncn: r.ncn, txHash: result.txHash });
        await sql`UPDATE credentials SET tx_hash=${result.txHash},anchored_at=NOW() WHERE ncn=${r.ncn}`;
      } else if (result?.error) {
        anchorErrors.push({ ncn: r.ncn, error: result.error });
      }
    }
  }
  if (results.length) await sql`UPDATE institutions SET issued_count=issued_count+${results.length},last_activity_at=NOW() WHERE id=${inst.id}`;
  return { results, errors, txHashes, anchorErrors };
}

// ─── Combined (Credential + Transcript) ───────────────────

async function processCombined(sql, inst, rows, pepper, wallet) {
  const results = [], errors = [];
  let students = [], current = null;
  for (const r of rows) {
    const t = ((r.type || '')+'').trim().toUpperCase();
    if (t === 'STUDENT') { current = { name:(r.student_name||'').trim(), matric:(r.matric_number||'').trim(), course:(r.course_name||'').trim(), degree:(r.degree_type||'').trim(), year:parseInt(r.graduation_year||r.grad_year,10), cgpa:parseFloat(r.cgpa)||null, subjects:[] }; students.push(current); }
    else if (t === 'SUBJECT' && current) { current.subjects.push({ code:(r.course_code||'').trim(), title:(r.course_title||'').trim(), credits:parseInt(r.credit_units,10)||0, score:parseInt(r.score,10)||0, grade:(r.grade||'').trim(), sem:(r.semester||'').trim(), ses:(r.session||'').trim() }); }
  }

  for (const s of students) {
    try {
      if (!s.name || !s.matric || !s.year || !s.course || !s.degree) { errors.push({ student: s.name||'?', error:'Missing fields', fields: { name: s.name, matric: s.matric, year: s.year, course: s.course, degree: s.degree, subjects: s.subjects?.length } }); continue; }

      // Credential
      const cs = salt();
      const ch = hashPayload(pepper, credPayload(s.name, s.year, s.course, s.degree, s.matric), cs);
      const cn = credNcn(inst.short_code, s.year);
      const [cred] = await sql`INSERT INTO credentials (institution_id,ncn,student_name,matric_number,grad_year,course_name,degree_type,salt,blockchain_hash)
        VALUES (${inst.id},${cn},${s.name},${s.matric},${s.year},${s.course},${s.degree},${cs},${ch}) RETURNING id`;

      // Transcript
      const ts = salt();
      const sh = subjectHash(s.subjects);
      const tc = s.subjects.reduce((a, x) => a + (x.credits||0), 0);
      const tp = transPayload(s.name, s.year, s.course, s.degree, s.matric, s.cgpa||0, tc, sh);
      const th = hashPayload(pepper, tp, ts);
      const tn = transNcn(inst.short_code, s.year);
      const [tran] = await sql`INSERT INTO transcripts (institution_id,ncn,linked_credential_id,student_name,matric_number,course_name,degree_type,graduation_year,cgpa,total_credits,salt,blockchain_hash,subjects_hash)
        VALUES (${inst.id},${tn},${cred.id},${s.name},${s.matric},${s.course},${s.degree},${s.year},${s.cgpa},${tc},${ts},${th},${sh}) RETURNING id`;

      // Subjects
      for (const sub of s.subjects) {
        await sql`INSERT INTO transcript_subjects (transcript_id,course_code,course_title,credit_units,score,grade,semester,session)
          VALUES (${tran.id},${sub.code},${sub.title},${sub.credits},${sub.score},${sub.grade},${sub.sem},${sub.ses})`;
      }

      results.push({ student_name:s.name, matric_number:s.matric, credential:{ ncn:cn, hash:ch }, transcript:{ ncn:tn, hash:th, subjects_count:s.subjects.length } });
    } catch (e) { errors.push({ student: s.name||'?', error: e.message }); }
  }

  let txHashes = [];
  let anchorErrors = [];
  if (results.length && process.env.CONTRACT_ADDRESS && wallet) {
    for (const r of results) {
      const ct = await anchorHash(r.credential.hash, wallet);
      if (ct?.txHash) {
        txHashes.push({ ncn:r.credential.ncn, type:'credential', txHash:ct.txHash });
        await sql`UPDATE credentials SET tx_hash=${ct.txHash},anchored_at=NOW() WHERE ncn=${r.credential.ncn}`;
      } else if (ct?.error) {
        anchorErrors.push({ ncn:r.credential.ncn, type:'credential', error:ct.error });
      }
      const tt = await anchorHash(r.transcript.hash, wallet);
      if (tt?.txHash) {
        txHashes.push({ ncn:r.transcript.ncn, type:'transcript', txHash:tt.txHash });
        await sql`UPDATE transcripts SET tx_hash=${tt.txHash},anchored_at=NOW() WHERE ncn=${r.transcript.ncn}`;
      } else if (tt?.error) {
        anchorErrors.push({ ncn:r.transcript.ncn, type:'transcript', error:tt.error });
      }
    }
  }
  if (results.length) await sql`UPDATE institutions SET issued_count=issued_count+${results.length},last_activity_at=NOW() WHERE id=${inst.id}`;
  return { results, errors, txHashes, anchorErrors };
}

// ─── Main ─────────────────────────────────────────────────

export default async function handler(req, res) {
  handlePreflight(req, res, 'POST, OPTIONS');
  if (req.method !== 'POST') return error(res, 'ACV_405', 'Method not allowed', 405);

  const inst = await authenticateInstitution(req);
  if (!inst) return error(res, 'ACV_401', 'Invalid institutional token', 401);
  if (!inst.is_active) return error(res, 'ACV_403', 'Institution deactivated', 403);

  try {
    const sql = getDb();
    const pepper = process.env.PROTOCOL_PEPPER;

    // Fetch institution's encrypted wallet key for on-chain signing
    let wallet = null;
    if (process.env.CONTRACT_ADDRESS && process.env.ALCHEMY_RPC_URL) {
      const [{ encrypted_private_key }] = await sql`
        SELECT encrypted_private_key FROM institutions WHERE id = ${inst.id}
      `;
      if (encrypted_private_key) {
        try {
          const { ethers } = await import('ethers');
          const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
          wallet = await walletFromInstitution(provider, encrypted_private_key);
        } catch (e) {
          console.error('WALLET_DECRYPT_WARN:', e.message);
        }
      }
    }

    let csvText = '';

    // Parse input
    if (typeof req.body === 'string') csvText = req.body;
    else if (req.body?.csv || req.body?.csvData) csvText = req.body.csv || req.body.csvData;
    else if (req.body?.batch) {
      // JSON batch → credential-only
      if (inst.issued_count + req.body.batch.length > inst.issuance_quota)
        return error(res, 'ACV_409', 'Quota exceeded', 403);
      const result = await processCredentials(sql, inst, req.body.batch, pepper, wallet);
      await logAudit('batch_issue', inst.id, null, { count: result.results.length, errors: result.errors.length, anchorErrors: result.anchorErrors?.length }, req);
      return res.status(200).json({ success: true, summary: { issued: result.results.length, errors: result.errors.length }, results: result.results, tx_hashes: result.txHashes, anchor_errors: result.anchorErrors?.length ? result.anchorErrors : undefined, blockchain_signing: !!wallet });
    }

    if (!csvText || !csvText.trim()) return error(res, 'ACV_400', 'CSV data or JSON batch required');

    // Strip BOM and normalize line endings
    const cleanCSV = csvText.replace(/^\uFEFF/, '').trim();
    const parsed = Papa.parse(cleanCSV, { header: true, skipEmptyLines: true, transformHeader: h => h.trim().toLowerCase().replace(/\s+/g, '_') });
    if (parsed.errors.length) {
      const fieldErrors = parsed.errors.filter(e => e.type === 'FieldMismatch');
      const otherErrors = parsed.errors.filter(e => e.type !== 'FieldMismatch');
      if (otherErrors.length) return error(res, 'ACV_400', 'CSV error: ' + otherErrors[0].message);
      // FieldMismatch is non-fatal — just log and continue with the data that parsed
      console.log('CSV field mismatch warnings:', parsed.errors.length);
    }
    if (!parsed.data.length) return error(res, 'ACV_400', 'CSV has no data rows');

    const headers = parsed.meta.fields || [];
    const isCombined = headers.includes('type');
    const isCredential = headers.includes('student_name') && headers.includes('matric_number');
    const hasSubjectCols = headers.includes('course_code');

    // Detect format
    if (isCombined) {
      const studentCount = parsed.data.filter(r => ((r.type||'')+'').trim().toUpperCase() === 'STUDENT').length;
      if (inst.issued_count + studentCount > inst.issuance_quota)
        return error(res, 'ACV_409', 'Quota exceeded', 403);
      const result = await processCombined(sql, inst, parsed.data, pepper, wallet);
      await logAudit('batch_issue', inst.id, null, { csvType: 'combined', students: result.results.length, errors: result.errors.length, txCount: result.txHashes?.length, anchorErrors: result.anchorErrors?.length }, req);
      // Debug: show first parsed row
      const debugSample = parsed.data[0] ? Object.entries(parsed.data[0]).slice(0, 8).map(([k,v]) => `${k}=${v}`).join(', ') : 'no data';
      return res.status(200).json({ success: true, csv_type: 'combined', summary: { total_students: result.results.length, errors: result.errors.length }, results: result.results, errors: result.errors, tx_hashes: result.txHashes, anchor_errors: result.anchorErrors?.length ? result.anchorErrors : undefined, blockchain_signing: !!wallet, _debug: { headers: parsed.meta.fields, sample: debugSample }, warnings: !process.env.CONTRACT_ADDRESS ? ['Blockchain not configured'] : undefined });
    }

    if (isCredential && !hasSubjectCols) {
      const rows = parsed.data.map(r => ({ student_name: r.student_name, matric_number: r.matric_number, course_name: r.course_name, degree_type: r.degree_type, graduation_year: r.graduation_year || r.grad_year }));
      if (inst.issued_count + rows.length > inst.issuance_quota)
        return error(res, 'ACV_409', 'Quota exceeded', 403);
      const result = await processCredentials(sql, inst, rows, pepper, wallet);
      await logAudit('batch_issue', inst.id, null, { csvType: 'credential', count: result.results.length, errors: result.errors.length, anchorErrors: result.anchorErrors?.length }, req);
      const debugSample2 = rows[0] ? `student_name=${rows[0].student_name}, matric=${rows[0].matric_number}, year=${rows[0].graduation_year}, course=${rows[0].course_name}, degree=${rows[0].degree_type}` : 'no data';
      return res.status(200).json({ success: true, summary: { issued: result.results.length, errors: result.errors.length }, results: result.results, errors: result.errors.length > 0 ? result.errors : undefined, tx_hashes: result.txHashes, anchor_errors: result.anchorErrors?.length ? result.anchorErrors : undefined, blockchain_signing: !!wallet, _debug: { headers: headers, sample: debugSample2 }, warnings: !process.env.CONTRACT_ADDRESS ? ['Blockchain not configured'] : undefined });
    }

    if (isCredential && hasSubjectCols && !isCombined)
      return error(res, 'ACV_400', 'CSV has subject columns but no "type" column. Add type column with STUDENT/SUBJECT markers, or use credential-only format (no course_code column). Download template from /api/v1/csv?type=transcript');

    return error(res, 'ACV_400', 'Unrecognized CSV format. See /api/v1/csv for templates');
  } catch (err) {
    console.error('ACV_ISSUE_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
