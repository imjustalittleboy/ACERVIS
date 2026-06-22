// ACERVIS API: Batch Issuance & Hashing (v3.1.0)
// Accepts: JSON { token, batch } or raw CSV text (Content-Type: text/csv)
// CSV columns: student_name,matric_number,course_name,degree_type,graduation_year
import { createHmac, randomBytes } from 'crypto';
import Papa from 'papaparse';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    // CORS
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-institution-token, x-super-admin-secret');
        return res.status(200).end();
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const sql = neon(process.env.DATABASE_URL);
        const pepper = process.env.PROTOCOL_PEPPER;

        // Parse input: JSON or CSV
        let token, batch;

        if (typeof req.body === 'string') {
            // Raw CSV body
            const parsed = Papa.parse(req.body.trim(), { header: true, skipEmptyLines: true });
            if (parsed.errors.length > 0) {
                return res.status(400).json({ error: 'CSV parse error: ' + parsed.errors[0].message });
            }
            token = req.headers['x-institution-token'];
            batch = parsed.data.map(row => ({
                name: (row.student_name || row.name || '').trim(),
                year: parseInt(row.graduation_year || row.grad_year || row.year, 10),
                course: (row.course_name || row.course || '').trim(),
                type: (row.degree_type || row.type || '').trim(),
                matric: (row.matric_number || row.matric || '').trim()
            }));
        } else {
            token = req.body?.token || req.headers['x-institution-token'];
            batch = req.body?.batch;
        }

        if (!token || !batch) {
            return res.status(400).json({ error: 'Institutional token and batch data required. Send JSON { token, batch } or CSV body with x-institution-token header.' });
        }

        // Authenticate
        const [institution] = await sql`
            SELECT id, issuance_quota, issued_count, short_code, name, is_active
            FROM institutions WHERE token_id = ${token} AND is_active = TRUE
        `;

        if (!institution) return res.status(401).json({ error: 'Invalid institutional token' });
        if (institution.issued_count + batch.length > institution.issuance_quota) {
            return res.status(403).json({ error: 'Issuance quota exceeded. Remaining: ' + (institution.issuance_quota - institution.issued_count) });
        }

        // Filter invalid rows
        const valid = batch.filter(s => s.name && s.matric && s.year && s.course && s.type);
        if (valid.length === 0) return res.status(400).json({ error: 'No valid student records found. Required: name, matric, year, course, type' });

        const results = [];

        for (const student of valid) {
            const salt = randomBytes(16).toString('hex');
            const payload = `${student.name}|${student.year}|${student.course}|${student.type}|${student.matric}`.toLowerCase();
            const hash = createHmac('sha256', pepper).update(payload + salt).digest('hex');
            const ncn = `${institution.short_code}-${student.year}-${randomBytes(4).toString('hex').toUpperCase()}`;

            await sql`
                INSERT INTO credentials (institution_id, ncn, student_name, matric_number, grad_year, course_name, degree_type, salt, blockchain_hash)
                VALUES (${institution.id}, ${ncn}, ${student.name}, ${student.matric}, ${student.year}, ${student.course}, ${student.type}, ${salt}, ${hash})
            `;

            results.push({ ncn, hash, name: student.name, matric: student.matric });
        }

        // Blockchain anchoring
        let txHashes = [];
        if (process.env.CONTRACT_ADDRESS && process.env.ALCHEMY_RPC_URL) {
            const { ethers } = await import('ethers');
            const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
            const wallet = new ethers.Wallet(process.env.INSTITUTION_PRIVATE_KEY || '', provider);
            const contract = new ethers.Contract(
                process.env.CONTRACT_ADDRESS,
                ['function anchorCredential(bytes32 _hash) external'],
                wallet
            );

            for (const r of results) {
                try {
                    const tx = await contract.anchorCredential('0x' + r.hash);
                    const receipt = await tx.wait();
                    txHashes.push({ ncn: r.ncn, txHash: receipt.hash });
                    await sql`UPDATE credentials SET tx_hash = ${receipt.hash}, anchored_at = NOW() WHERE ncn = ${r.ncn}`;
                } catch (e) {
                    console.error('ACV_CHAIN_ANCHOR_WARN:', e.message);
                }
            }
        }

        // Update quota
        await sql`UPDATE institutions SET issued_count = issued_count + ${results.length}, last_activity_at = NOW() WHERE id = ${institution.id}`;

        // Audit
        await sql`
            INSERT INTO audit_logs (action, actor_id, metadata)
            VALUES ('batch_issue', ${institution.id}, ${JSON.stringify({ count: results.length, total: batch.length, skipped: batch.length - valid.length })})
        `.catch(e => console.error('AUDIT_WARN:', e.message));

        return res.status(200).json({
            success: true,
            summary: { issued: results.length, skipped: batch.length - valid.length },
            results,
            tx_hashes: txHashes.length > 0 ? txHashes : undefined
        });

    } catch (error) {
        console.error('ACV_ISSUE_ERROR:', error);
        return res.status(500).json({ error: 'Internal server error', code: 'ACV_500' });
    }
}
