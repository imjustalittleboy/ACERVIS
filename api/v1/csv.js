// ACERVIS: CSV Utility API (v3.1.0)
// GET  /api/v1/csv?type=credential         — Download credential-only CSV template
// GET  /api/v1/csv?type=transcript          — Download combined CSV template
// POST /api/v1/csv?action=validate          — Validate CSV structure before importing
import Papa from 'papaparse';
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';

// ─── Templates ─────────────────────────────────────────────

const CREDENTIAL_TEMPLATE = `student_name,matric_number,course_name,degree_type,graduation_year
John Doe,ADU/2020/001,Computer Science,BSc,2024
Jane Smith,ADU/2020/002,Mathematics,BSc,2024`;

const COMBINED_TEMPLATE = `type,student_name,matric_number,course_name,degree_type,graduation_year,cgpa,course_code,course_title,credit_units,score,grade,semester,session
STUDENT,John Doe,ADU/2020/001,Computer Science,BSc,2024,4.82,,,,,,,
SUBJECT,,,,,,,,CSC101,Introduction to Programming,3,78,A,First,2020/2021
SUBJECT,,,,,,,,CSC102,Data Structures,3,82,A,First,2020/2021
SUBJECT,,,,,,,,CSC201,Database Systems,3,71,B,Second,2020/2021
STUDENT,Jane Smith,ADU/2020/002,Mathematics,BSc,2024,4.91,,,,,,,
SUBJECT,,,,,,,,MTH201,Abstract Algebra,3,95,A,First,2021/2022
SUBJECT,,,,,,,,MTH202,Real Analysis,3,88,A,First,2021/2022
SUBJECT,,,,,,,,MTH301,Complex Analysis,3,76,A,Second,2021/2022`;

const VERIFY_TEMPLATE = `ncn
ADUN-2025-A3F8D9C2
ADUN-T-2025-B4E9F1A3`;

function csvResponse(res, content, filename) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(content);
}

// ─── Validation ────────────────────────────────────────────

function validateHeaders(parsed, requiredHeaders) {
  const headers = parsed.meta.fields || [];
  const missing = requiredHeaders.filter(h => !headers.includes(h.toLowerCase()));
  return {
    valid: missing.length === 0,
    missing,
    headers_found: headers,
    row_count: parsed.data.length
  };
}

function validateCredentialData(rows) {
  const errors = [];
  const seen = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-indexed + header row
    const name = (row.student_name || '').trim();
    const matric = (row.matric_number || '').trim();
    const year = parseInt(row.graduation_year || row.grad_year, 10);
    const course = (row.course_name || '').trim();
    const degree = (row.degree_type || '').trim();

    if (!name) errors.push(`Row ${rowNum}: Missing student_name`);
    if (!matric) errors.push(`Row ${rowNum}: Missing matric_number`);
    if (!year || isNaN(year)) errors.push(`Row ${rowNum}: Invalid graduation_year`);
    if (!course) errors.push(`Row ${rowNum}: Missing course_name`);
    if (!degree) errors.push(`Row ${rowNum}: Missing degree_type`);

    const key = name + '|' + matric;
    if (seen.has(key)) errors.push(`Row ${rowNum}: Duplicate student (${name} / ${matric})`);
    seen.add(key);
  }

  return errors;
}

function validateCombinedData(rows) {
  const errors = [];
  let currentStudent = null;
  let studentCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const type = ((row.type || '') + '').trim().toUpperCase();

    if (type === 'STUDENT') {
      currentStudent = row;
      studentCount++;

      const name = (row.student_name || '').trim();
      const matric = (row.matric_number || '').trim();
      const year = parseInt(row.graduation_year || row.grad_year, 10);

      if (!name) errors.push(`Row ${rowNum} (STUDENT): Missing student_name`);
      if (!matric) errors.push(`Row ${rowNum} (STUDENT): Missing matric_number`);
      if (!year || isNaN(year)) errors.push(`Row ${rowNum} (STUDENT): Invalid graduation_year`);

    } else if (type === 'SUBJECT') {
      if (!currentStudent) {
        errors.push(`Row ${rowNum}: SUBJECT row before any STUDENT row`);
        continue;
      }

      const code = (row.course_code || '').trim();
      const title = (row.course_title || '').trim();
      const credits = parseInt(row.credit_units, 10);
      const score = parseInt(row.score, 10);
      const grade = (row.grade || '').trim();
      const semester = (row.semester || '').trim();
      const session = (row.session || '').trim();

      if (!code) errors.push(`Row ${rowNum}: Missing course_code`);
      if (!title) errors.push(`Row ${rowNum}: Missing course_title`);
      if (!credits || isNaN(credits) || credits < 1) errors.push(`Row ${rowNum}: Invalid credit_units`);
      if (isNaN(score) || score < 0 || score > 100) errors.push(`Row ${rowNum}: Invalid score (0-100)`);
      if (!grade) errors.push(`Row ${rowNum}: Missing grade`);
      if (!['First', 'Second', 'Summer'].includes(semester)) errors.push(`Row ${rowNum}: Invalid semester (First/Second/Summer)`);
      if (!session) errors.push(`Row ${rowNum}: Missing session`);
    } else {
      errors.push(`Row ${rowNum}: Unknown type "${type}". Must be STUDENT or SUBJECT.`);
    }
  }

  if (!currentStudent) errors.push('No STUDENT rows found in CSV');

  return { errors, student_count: studentCount };
}

// ─── Handler ───────────────────────────────────────────────

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, POST, OPTIONS');

  try {
    // ── GET: Download template (public, no auth needed) ──
    if (req.method === 'GET') {
      const type = req.query.type || 'credential';

      switch (type) {
        case 'credential':
          return csvResponse(res, CREDENTIAL_TEMPLATE, 'acervis-credential-template.csv');
        case 'transcript':
        case 'combined':
          return csvResponse(res, COMBINED_TEMPLATE, 'acervis-combined-template.csv');
        case 'verify':
          return csvResponse(res, VERIFY_TEMPLATE, 'acervis-verify-template.csv');
        default:
          return error(res, 'ACV_400', 'Type must be: credential, transcript, or verify');
      }
    }

    // ── POST: Validate (requires auth) ──
    if (req.method === 'POST') {
      const institution = await authenticateInstitution(req);
      if (!institution) return error(res, 'ACV_401', 'Authentication required', 401);
      let csvText = '';

      if (typeof req.body === 'string') {
        csvText = req.body;
      } else if (req.body?.csv || req.body?.csvData) {
        csvText = req.body.csv || req.body.csvData;
      } else {
        return error(res, 'ACV_400', 'CSV data required');
      }

      if (!csvText.trim()) return error(res, 'ACV_400', 'Empty CSV data');

      const parsed = Papa.parse(csvText.trim(), { header: true, skipEmptyLines: true });

      if (parsed.errors.length > 0) {
        return error(res, 'ACV_400', 'CSV parse error: ' + parsed.errors[0].message);
      }

      if (parsed.data.length === 0) {
        return error(res, 'ACV_400', 'CSV has no data rows');
      }

      const headers = parsed.meta.fields || [];
      const hasTypeCol = headers.includes('type');
      const hasSubjectCols = headers.includes('course_code');
      let validation;

      if (hasTypeCol) {
        validation = validateCombinedData(parsed.data);
      } else if (hasSubjectCols) {
        validation = {
          errors: ['Combined CSV without type column. Add "type" column with STUDENT/SUBJECT markers.'],
          student_count: 0
        };
      } else {
        const hCheck = validateHeaders(parsed, ['student_name', 'matric_number', 'course_name', 'degree_type', 'graduation_year']);
        if (!hCheck.valid) {
          return res.status(200).json({
            type: 'credential',
            valid: false,
            errors: [`Missing columns: ${hCheck.missing.join(', ')}`],
            headers_found: hCheck.headers_found
          });
        }
        const dataErrors = validateCredentialData(parsed.data);
        validation = { errors: dataErrors, student_count: parsed.data.length };
      }

      await logAudit('csv_validated', institution.id, null, {
        type: hasTypeCol ? 'combined' : 'credential',
        rows: parsed.data.length,
        errors: validation.errors.length,
        student_count: validation.student_count
      }, req);

      return res.status(200).json({
        type: hasTypeCol ? 'combined' : 'credential',
        valid: validation.errors.length === 0,
        errors: validation.errors,
        row_count: parsed.data.length,
        student_count: validation.student_count
      });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);

  } catch (err) {
    console.error('ACV_CSV_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
