// ACERVIS: Combined Batch Issue (v3.1.0)
// Handles: credential-only CSV and combined (credential+transcript) CSV with auto-detection.
// Combined format uses type markers: STUDENT rows + SUBJECT rows.
import { createHash, createHmac, randomBytes } from 'crypto';
import Papa from 'papaparse';
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';

// ─── Crypto Helpers ───────────────────────────────────────────

function synthesizeHash(payload, salt) {
  const pepper = process.env.PROTOCOL_PEPPER;
  return createHmac('sha256', pepper).update(payload + salt).digest('hex');
}

function generateSalt() {
  return randomBytes(16).toString('hex');
}

function randomHex(bytes = 4) {
  return randomBytes(bytes).toString('hex').toUpperCase();
}

function credentialNcn(shortCode, year) {
  return `${shortCode}-${year}-${randomHex()}`;
}

function transcriptNcn(shortCode, year) {
  return `${shortCode}-T-${year}-${randomHex()}`;
}

function buildCredentialPayload(name, year, course, degree, matric) {
  return `${name}|${year}|${course}|${degree}|${matric}`.toLowerCase();
}

function buildTranscriptPayload(name, year, course, degree, matric, cgpa, credits, subjectsHash) {
  return `${name}|${year}|${course}|${degree}|${matric}|${cgpa}|${credits}|${subjectsHash}`.toLowerCase();
}

function hashSubjects(subjects) {
  const concatenated = subjects
    .map(s => `${s.course_code}|${s.credit_units}|${s.score}|${s.grade}|${s.semester}|${s.session}`)
    .join('||');
  return createHash('sha256').update(concatenated).digest('hex');
}

// ─── CSV Detection ────────────────────────────────────────────

function detectCsvType(headers) {
  const h = headers.map(x => x.trim().toLowerCase());
  const hasTypeCol = h.includes('type');
  const hasStudentCols = h.includes('student_name') && h.includes('matric_number');
  const hasSubjectCols = h.includes('course_code') && h.includes('credit_units');
  const hasCgpa = h.includes('cgpa');

  if (hasTypeCol) return 'combined_markers';   // STUDENT/SUBJECT type rows
  if (hasStudentCols && hasSubjectCols) return 'combined_note';  // has student + subject data but no type column
  if (hasStudentCols && !hasSubjectCols) return 'credential_only';
  return 'unknown';
}

// ─── Blockchain Anchoring ─────────────────────────────────────

async function anchorHash(hash) {
  if (!process.env.CONTRACT_ADDRESS || !process.env.ALCHEMY_RPC_URL) {
    return null; // blockchain not configured
  }
  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
    const wallet = new ethers.Wallet(process.env.INSTITUTION_PRIVATE_KEY || '', provider);
    const contract = new ethers.Contract(
      process.env.CONTRACT_ADDRESS,
      ['function anchorCredential(bytes32 _hash) external returns (bool)'],
      wallet
    );
    const tx = await contract.anchorCredential('0x' + hash);
    const receipt = await tx.wait();
    return receipt.hash;
  } catch (err) {
    console.error('ACV_CHAIN_ANCHOR_WARN:', err.message);
    return null; // non-blocking
  }
}

// ─── Process Credential-Only CSV ──────────────────────────────

async function processCredentialOnly(sql, institution, rows, pepper) {
  const results = [];
  const errors = [];

  for (const row of rows) {
    try {
      const name = (row.student_name || '').trim();
      const matric = (row.matric_number || '').trim();
      const year = parseInt(row.graduation_year || row.grad_year, 10);
      const course = (row.course_name || '').trim();
      const degree = (row.degree_type || '').trim();

      if (!name || !matric || !year || !course || !degree) {
        errors.push({ row: name || matric, error: 'Missing required fields' });
        continue;
      }

      const salt = generateSalt();
      const payload = buildCredentialPayload(name, year, course, degree, matric);
      const hash = synthesizeHash(payload, salt);
      const ncn = credentialNcn(institution.short_code, year);

      await sql`
        INSERT INTO credentials (institution_id, ncn, student_name, matric_number, 
          grad_year, course_name, degree_type, salt, blockchain_hash)
        VALUES (${institution.id}, ${ncn}, ${name}, ${matric}, 
          ${year}, ${course}, ${degree}, ${salt}, ${hash})
      `;

      results.push({ ncn, hash, student_name: name, matric_number: matric, type: 'credential' });
    } catch (err) {
      errors.push({ row: row.student_name || 'unknown', error: err.message });
    }
  }

  // Blockchain anchoring
  let txHashes = [];
  if (results.length > 0 && process.env.CONTRACT_ADDRESS) {
    for (const r of results) {
      const txHash = await anchorHash(r.hash);
      if (txHash) {
        txHashes.push({ ncn: r.ncn, txHash });
        await sql`UPDATE credentials SET tx_hash = ${txHash}, anchored_at = NOW() WHERE ncn = ${r.ncn}`;
      }
    }
  }

  // Update issued count
  if (results.length > 0) {
    await sql`
      UPDATE institutions SET issued_count = issued_count + ${results.length}, 
        last_activity_at = NOW() WHERE id = ${institution.id}
    `;
  }

  return { results, errors, txHashes };
}

// ─── Process Combined (STUDENT + SUBJECT) CSV ─────────────────

async function processCombined(sql, institution, rows, pepper) {
  const results = [];
  const errors = [];

  // Group rows by student (STUDENT rows + their SUBJECT rows)
  let students = [];
  let currentStudent = null;

  for (const row of rows) {
    const type = ((row.type || '') + '').trim().toUpperCase();
    if (type === 'STUDENT') {
      currentStudent = {
        name: (row.student_name || '').trim(),
        matric: (row.matric_number || '').trim(),
        course: (row.course_name || '').trim(),
        degree: (row.degree_type || '').trim(),
        year: parseInt(row.graduation_year || row.grad_year, 10),
        cgpa: parseFloat(row.cgpa) || null,
        subjects: []
      };
      students.push(currentStudent);
    } else if (type === 'SUBJECT' && currentStudent) {
      currentStudent.subjects.push({
        course_code: (row.course_code || '').trim(),
        course_title: (row.course_title || '').trim(),
        credit_units: parseInt(row.credit_units, 10) || 0,
        score: parseInt(row.score, 10) || 0,
        grade: (row.grade || '').trim(),
        semester: (row.semester || '').trim(),
        session: (row.session || '').trim()
      });
    }
  }

  for (const student of students) {
    try {
      if (!student.name || !student.matric || !student.year || !student.course || !student.degree) {
        errors.push({ student: student.name || 'unknown', error: 'Missing required fields' });
        continue;
      }

      // ── 1. Create Credential ──
      const credSalt = generateSalt();
      const credPayload = buildCredentialPayload(student.name, student.year, student.course, student.degree, student.matric);
      const credHash = synthesizeHash(credPayload, credSalt);
      const credNcn = credentialNcn(institution.short_code, student.year);

      const [credential] = await sql`
        INSERT INTO credentials (institution_id, ncn, student_name, matric_number,
          grad_year, course_name, degree_type, salt, blockchain_hash)
        VALUES (${institution.id}, ${credNcn}, ${student.name}, ${student.matric},
          ${student.year}, ${student.course}, ${student.degree}, ${credSalt}, ${credHash})
        RETURNING id
      `;

      // ── 2. Create Transcript with Subjects ──
      const transSalt = generateSalt();
      const subHash = hashSubjects(student.subjects);
      const totalCredits = student.subjects.reduce((sum, s) => sum + (s.credit_units || 0), 0);
      const transPayload = buildTranscriptPayload(
        student.name, student.year, student.course, student.degree, student.matric,
        student.cgpa || 0, totalCredits, subHash
      );
      const transHash = synthesizeHash(transPayload, transSalt);
      const transNcn = transcriptNcn(institution.short_code, student.year);

      const [transcript] = await sql`
        INSERT INTO transcripts (institution_id, ncn, linked_credential_id,
          student_name, matric_number, course_name, degree_type, graduation_year,
          cgpa, total_credits, salt, blockchain_hash, subjects_hash)
        VALUES (${institution.id}, ${transNcn}, ${credential.id},
          ${student.name}, ${student.matric}, ${student.course}, ${student.degree},
          ${student.year}, ${student.cgpa}, ${totalCredits}, ${transSalt}, ${transHash}, ${subHash})
        RETURNING id
      `;

      // ── 3. Insert Subject Rows ──
      for (const sub of student.subjects) {
        await sql`
          INSERT INTO transcript_subjects (transcript_id, course_code, course_title,
            credit_units, score, grade, semester, session)
          VALUES (${transcript.id}, ${sub.course_code}, ${sub.course_title},
            ${sub.credit_units}, ${sub.score}, ${sub.grade}, ${sub.semester}, ${sub.session})
        `;
      }

      const studentResult = {
        student_name: student.name,
        matric_number: student.matric,
        credential: { ncn: credNcn, hash: credHash },
        transcript: { ncn: transNcn, hash: transHash, subjects_count: student.subjects.length }
      };
      results.push(studentResult);
    } catch (err) {
      errors.push({ student: student.name || 'unknown', error: err.message });
    }
  }

  // ── 4. Blockchain Anchoring (both hashes) ──
  let txHashes = [];
  if (results.length > 0 && process.env.CONTRACT_ADDRESS) {
    for (const r of results) {
      // Anchor credential hash
      const credTx = await anchorHash(r.credential.hash);
      if (credTx) {
        txHashes.push({ ncn: r.credential.ncn, type: 'credential', txHash: credTx });
        await sql`UPDATE credentials SET tx_hash = ${credTx}, anchored_at = NOW() WHERE ncn = ${r.credential.ncn}`;
      }
      // Anchor transcript hash
      const transTx = await anchorHash(r.transcript.hash);
      if (transTx) {
        txHashes.push({ ncn: r.transcript.ncn, type: 'transcript', txHash: transTx });
        await sql`UPDATE transcripts SET tx_hash = ${transTx}, anchored_at = NOW() WHERE ncn = ${r.transcript.ncn}`;
      }
    }
  }

  // Update issued count (count credentials issued)
  if (results.length > 0) {
    await sql`
      UPDATE institutions SET issued_count = issued_count + ${results.length},
        last_activity_at = NOW() WHERE id = ${institution.id}
    `;
  }

  return { results, errors, txHashes };
}

// ─── Main Handler ─────────────────────────────────────────────

export default async function handler(req, res) {
  handlePreflight(req, res, 'POST, OPTIONS');

  if (req.method !== 'POST') {
    return error(res, 'ACV_405', 'Method not allowed', 405);
  }

  // Authenticate institution via x-institution-token
  const institution = await authenticateInstitution(req);
  if (!institution) {
    return error(res, 'ACV_401', 'Invalid institutional token', 401);
  }

  if (!institution.is_active) {
    return error(res, 'ACV_403', 'Institution is deactivated', 403);
  }

  try {
    // Parse CSV from request body
    let csvText = '';

    if (typeof req.body === 'string') {
      csvText = req.body;
    } else if (req.body && typeof req.body.csv === 'string') {
      csvText = req.body.csv;
    } else if (req.body && typeof req.body.csvData === 'string') {
      csvText = req.body.csvData;
    } else if (Buffer.isBuffer(req.body)) {
      csvText = req.body.toString('utf-8');
    } else {
      return error(res, 'ACV_400', 'CSV data required. Send raw CSV text in body, or JSON with { csv: "..." }', 400);
    }

    if (!csvText.trim()) {
      return error(res, 'ACV_400', 'Empty CSV data', 400);
    }

    // Parse with PapaParse
    const parsed = Papa.parse(csvText.trim(), {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim().toLowerCase()
    });

    if (parsed.errors.length > 0) {
      return error(res, 'ACV_400', 'CSV parse error: ' + parsed.errors[0].message);
    }

    if (parsed.data.length === 0) {
      return error(res, 'ACV_400', 'CSV has no data rows', 400);
    }

    const headers = parsed.meta.fields || [];
    const csvType = detectCsvType(headers);

    let result;
    const startTime = Date.now();

    switch (csvType) {
      case 'credential_only':
        if (institution.issued_count + parsed.data.length > institution.issuance_quota) {
          return error(res, 'ACV_409', `Issuance quota exceeded. Remaining: ${institution.issuance_quota - institution.issued_count}`, 403);
        }
        result = await processCredentialOnly(getDb(), institution, parsed.data, process.env.PROTOCOL_PEPPER);
        break;

      case 'combined_markers':
        if (institution.issued_count + parsed.data.filter(r => (r.type || '').trim().toUpperCase() === 'STUDENT').length > institution.issuance_quota) {
          return error(res, 'ACV_409', 'Issuance quota exceeded', 403);
        }
        result = await processCombined(getDb(), institution, parsed.data, process.env.PROTOCOL_PEPPER);
        break;

      case 'combined_note':
        return error(res, 'ACV_400',
          'CSV has both student columns and course columns but is missing a "type" column. '
          + 'Add a "type" column with STUDENT rows for student info and SUBJECT rows for courses. '
          + 'Download the combined template from /api/v1/csv?type=transcript for the correct format.', 400);

      default:
        return error(res, 'ACV_400', 
          'Unrecognized CSV format. For credentials, use columns: student_name, matric_number, course_name, degree_type, graduation_year. ' +
          'For combined, add type column with STUDENT/SUBJECT markers and subject columns.', 400);
    }

    const elapsed = Date.now() - startTime;

    // Audit log
    await logAudit('batch_issue', institution.id, null, {
      csvType,
      studentCount: result.results.length,
      errorCount: result.errors.length,
      txCount: result.txHashes?.length || 0,
      elapsed
    }, req);

    return res.status(200).json({
      success: true,
      csv_type: csvType,
      summary: {
        total_students: result.results.length,
        errors: result.errors.length,
        blockchain_anchored: (result.txHashes?.length || 0) > 0
      },
      results: result.results,
      errors: result.errors.length > 0 ? result.errors : undefined,
      tx_hashes: result.txHashes?.length > 0 ? result.txHashes : undefined,
      elapsed_ms: elapsed,
      warnings: !process.env.CONTRACT_ADDRESS ? ['Blockchain anchoring not configured. Records saved to database only.'] : undefined
    });

  } catch (err) {
    console.error('ACV_BATCH_ISSUE_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
