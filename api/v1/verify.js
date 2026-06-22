// ACERVIS: Verification Logic (v3.1.0)
// Supports: credential NCNs, transcript NCNs (with full subject breakdown), batch CSV
// GET /api/v1/verify?ncn=XXXX  — Single verification
// POST /api/v1/verify (raw CSV body) — Batch verification
import { createHmac, createHash } from 'crypto';
import { ethers } from 'ethers';
import Papa from 'papaparse';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    // CORS
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(200).end();
    }

    const sql = neon(process.env.DATABASE_URL);
    const pepper = process.env.PROTOCOL_PEPPER;

    // ── BATCH VERIFY (POST with raw CSV) ──
    if (req.method === 'POST') {
        let csvText = '';
        if (typeof req.body === 'string') csvText = req.body;
        else if (req.body?.csv) csvText = req.body.csv;
        else return res.status(400).json({ error: 'Send raw CSV body with ncn column' });

        const parsed = Papa.parse(csvText.trim(), { header: true, skipEmptyLines: true });
        const ncns = parsed.data.map(r => (r.ncn || '').trim()).filter(Boolean);

        if (ncns.length === 0) return res.status(400).json({ error: 'No NCNs found in CSV' });
        if (ncns.length > 500) return res.status(400).json({ error: 'Maximum 500 NCNs per batch' });

        const results = [];
        for (const ncn of ncns) {
            try {
                const result = await verifySingle(sql, pepper, ncn);
                results.push({ ncn, state: result.state, student_name: result.metadata?.student_name || '—' });
            } catch (e) {
                results.push({ ncn, state: 'ERROR', error: e.message });
            }

            // Log verification request
            await logVerification(sql, ncn, 'batch', results[results.length - 1].state, false, req);
        }

        return res.status(200).json({
            success: true,
            total: ncns.length,
            verified: results.filter(r => r.state === 'VERIFIED').length,
            results
        });
    }

    // ── SINGLE VERIFY (GET with ncn query param) ──
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { ncn } = req.query;
    if (!ncn) return res.status(400).json({ error: 'NCN required' });

    const startTime = Date.now();

    try {
        const result = await verifySingle(sql, pepper, ncn);
        const elapsed = Date.now() - startTime;

        // Log verification request
        await logVerification(sql, ncn, 'single', result.state, !!result.blockchain, req, elapsed);

        return res.status(200).json(result);
    } catch (error) {
        console.error('ACV_VERIFY_ERROR:', error);
        await logVerification(sql, ncn || 'unknown', 'single', 'ERROR', false, req, Date.now() - startTime);
        return res.status(500).json({ error: 'Internal server error', code: 'ACV_500' });
    }
}

// ─── Core Verification Engine ─────────────────────────────────

async function verifySingle(sql, pepper, ncn) {
    const isTranscript = ncn.includes('-T-');

    if (isTranscript) {
        return await verifyTranscript(sql, pepper, ncn);
    }
    return await verifyCredential(sql, pepper, ncn);
}

// ─── Credential Verification ──────────────────────────────────

async function verifyCredential(sql, pepper, ncn) {
    const [record] = await sql`
        SELECT c.*, i.name AS institution_name, i.short_code, i.type AS institution_type
        FROM credentials c JOIN institutions i ON c.institution_id = i.id
        WHERE c.ncn = ${ncn}
    `;

    if (!record) {
        return { state: 'NOT_FOUND', metadata: null, blockchain: null };
    }

    // Recompute hash for integrity check
    const payload = `${record.student_name}|${record.grad_year}|${record.course_name}|${record.degree_type}|${record.matric_number}`.toLowerCase();
    const localHash = createHmac('sha256', pepper).update(payload + record.salt).digest('hex');
    const integrityOk = localHash === record.blockchain_hash;

    if (!integrityOk) {
        await sql`
            INSERT INTO audit_logs (action, target_id, metadata) 
            VALUES ('verify_tampered', ${record.id}, ${JSON.stringify({ ncn, reason: 'Hash mismatch', payload, saltPrefix: record.salt?.slice(0,8), computed: localHash?.slice(0,16), stored: record.blockchain_hash?.slice(0,16) })})
        `.catch(() => {});
        return { state: 'TAMPERED', metadata: { ...record, _debug: { payload, computed_prefix: localHash?.slice(0,16), stored_prefix: record.blockchain_hash?.slice(0,16), salt_prefix: record.salt?.slice(0,8) } }, blockchain: null, integrity_check: 'FAILED' };
    }

    // Blockchain verification
    let bcResult = null;
    if (process.env.CONTRACT_ADDRESS && process.env.ALCHEMY_RPC_URL) {
        try {
            const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
            const contract = new ethers.Contract(
                process.env.CONTRACT_ADDRESS,
                ['function verify(bytes32 _hash) view returns (uint8, uint256, address)'],
                provider
            );
            const [status, anchoredAt, issuedBy] = await contract.verify('0x' + localHash);
            const states = ['NOT_FOUND', 'VERIFIED', 'SUSPENDED', 'REVOKED'];
            const mapped = states[status] || 'NOT_FOUND';
            bcResult = { anchoredAt: Number(anchoredAt), issuedBy };

            // Map DB status to blockchain state
            let effective = mapped;
            if (mapped === 'VERIFIED' && record.status === 'revoked') effective = 'REVOKED';
            else if (mapped === 'VERIFIED' && record.status === 'suspended') effective = 'SUSPENDED';
            else if (mapped === 'NOT_FOUND') effective = record.status === 'revoked' ? 'REVOKED' : record.status === 'suspended' ? 'SUSPENDED' : 'VERIFIED';

            await logAudit(sql, 'verify_' + effective.toLowerCase(), null, record.id, { ncn, state: effective, integrity: 'PASSED' });

            return {
                state: effective,
                record_type: 'credential',
                metadata: { ...record, record_type: 'credential' },
                blockchain: bcResult,
                integrity_check: 'PASSED'
            };
        } catch (chainError) {
            console.error('ACV_CHAIN_VERIFY_WARN:', chainError.message);
        }
    }

    // DB-only fallback
    const dbState = record.status === 'revoked' ? 'REVOKED' : record.status === 'suspended' ? 'SUSPENDED' : 'VERIFIED';
    await logAudit(sql, 'verify_' + dbState.toLowerCase(), null, record.id, { ncn, state: dbState });
    return {
        state: dbState,
        record_type: 'credential',
        metadata: { ...record, record_type: 'credential' },
        blockchain: null,
        integrity_check: 'PASSED',
        warning: 'Blockchain verification not configured.'
    };
}

// ─── Transcript Verification (with Full Subject Breakdown) ────

async function verifyTranscript(sql, pepper, ncn) {
    const [record] = await sql`
        SELECT t.*, i.name AS institution_name, i.short_code, i.type AS institution_type
        FROM transcripts t JOIN institutions i ON t.institution_id = i.id
        WHERE t.ncn = ${ncn}
    `;

    if (!record) {
        return { state: 'NOT_FOUND', metadata: null, blockchain: null };
    }

    // Fetch subjects
    const subjects = await sql`
        SELECT * FROM transcript_subjects WHERE transcript_id = ${record.id}
        ORDER BY session, 
          CASE semester WHEN 'First' THEN 1 WHEN 'Second' THEN 2 WHEN 'Summer' THEN 3 END,
          course_code
    `;

    // Recompute hash: includes full subject data for integrity
    const subHash = createHash('sha256')
        .update(subjects.map(s => `${s.course_code}|${s.credit_units}|${s.score}|${s.grade}|${s.semester}|${s.session}`).join('||'))
        .digest('hex');
    const payload = `${record.student_name}|${record.graduation_year}|${record.course_name}|${record.degree_type}|${record.matric_number}|${record.cgpa}|${record.total_credits}|${subHash}`.toLowerCase();
    const localHash = createHmac('sha256', pepper).update(payload + record.salt).digest('hex');
    const integrityOk = localHash === record.blockchain_hash;
    const subjectsMatch = subHash === record.subjects_hash;

    if (!integrityOk || !subjectsMatch) {
        await sql`
            INSERT INTO audit_logs (action, target_id, metadata)
            VALUES ('verify_tampered', ${record.id}, ${JSON.stringify({ ncn, reason: 'Hash or subject mismatch', integrity_ok: integrityOk, subjects_ok: subjectsMatch })})
        `.catch(() => {});
        return {
            state: 'TAMPERED',
            record_type: 'transcript',
            metadata: record,
            subjects,
            blockchain: null,
            integrity_check: 'FAILED',
            subjects_hash_match: subjectsMatch
        };
    }

    // Blockchain verification
    let bcResult = null;
    if (process.env.CONTRACT_ADDRESS && process.env.ALCHEMY_RPC_URL) {
        try {
            const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
            const contract = new ethers.Contract(
                process.env.CONTRACT_ADDRESS,
                ['function verify(bytes32 _hash) view returns (uint8, uint256, address)'],
                provider
            );
            const [status, anchoredAt, issuedBy] = await contract.verify('0x' + localHash);
            bcResult = { anchoredAt: Number(anchoredAt), issuedBy };

            let effective = ['NOT_FOUND','VERIFIED','SUSPENDED','REVOKED'][status] || 'NOT_FOUND';
            if (effective === 'VERIFIED' && record.status === 'revoked') effective = 'REVOKED';
            else if (effective === 'VERIFIED' && record.status === 'suspended') effective = 'SUSPENDED';
            else if (effective === 'NOT_FOUND') effective = record.status === 'revoked' ? 'REVOKED' : record.status === 'suspended' ? 'SUSPENDED' : 'VERIFIED';

            await logAudit(sql, 'verify_' + effective.toLowerCase(), null, record.id, { ncn, state: effective });

            return {
                state: effective,
                record_type: 'transcript',
                metadata: { ...record, record_type: 'transcript' },
                subjects,
                blockchain: bcResult,
                integrity_check: 'PASSED',
                subjects_hash_match: true,
                tx_hash: record.tx_hash
            };
        } catch (chainError) {
            console.error('ACV_CHAIN_VERIFY_WARN:', chainError.message);
        }
    }

    const dbState = record.status === 'revoked' ? 'REVOKED' : record.status === 'suspended' ? 'SUSPENDED' : 'VERIFIED';
    await logAudit(sql, 'verify_' + dbState.toLowerCase(), null, record.id, { ncn, state: dbState });
    return {
        state: dbState,
        record_type: 'transcript',
        metadata: { ...record, record_type: 'transcript' },
        subjects,
        blockchain: null,
        integrity_check: 'PASSED',
        subjects_hash_match: true,
        warning: 'Blockchain verification not configured.'
    };
}

// ─── Helpers ──────────────────────────────────────────────────

async function logAudit(sql, action, actorId, targetId, metadata) {
    try {
        await sql`
            INSERT INTO audit_logs (action, actor_id, target_id, metadata)
            VALUES (${action}, ${actorId}, ${targetId}, ${JSON.stringify(metadata)})
        `;
    } catch (e) { console.error('AUDIT_WARN:', e.message); }
}

async function logVerification(sql, ncn, type, resultState, blockchainVerified, req, ms) {
    try {
        await sql`
            INSERT INTO verification_requests (ncn, record_type, ip_address, user_agent, result_state, blockchain_verified, response_time_ms)
            VALUES (${ncn}, ${type}, ${req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null}, 
              ${req?.headers?.['user-agent'] || null}, ${resultState}, ${blockchainVerified}, ${ms || null})
        `;
    } catch (e) { /* non-critical */ }
}
