// ACERVIS API: Batch Issuance & Hashing (v3.0.0)
import { createHmac, randomBytes } from 'crypto';
import { neon } from '@neondatabase/serverless';
import { ethers } from 'ethers';

export default async function handler(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-super-admin-secret');
        return res.status(200).end();
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { token, batch } = req.body;
    if (!token || !batch) return res.status(400).json({ error: 'Missing token or batch' });

    try {
        const sql = neon(process.env.DATABASE_URL);

        // 1. Authenticate Institution & Check Quota
        const [institution] = await sql`
            SELECT id, issuance_quota, issued_count, short_code, name
            FROM institutions 
            WHERE token_id = ${token} AND is_active = TRUE
        `;

        if (!institution) return res.status(401).json({ error: 'Invalid institutional token' });
        if (institution.issued_count + batch.length > institution.issuance_quota) {
            return res.status(403).json({ error: 'Issuance quota exceeded' });
        }

        const pepper = process.env.PROTOCOL_PEPPER;
        const results = [];

        // 2. Process Batch (Synthesis)
        for (const student of batch) {
            const salt = randomBytes(16).toString('hex');
            const payload = `${student.name}|${student.year}|${student.course}|${student.type}|${student.matric}`.toLowerCase();
            const hash = createHmac('sha256', pepper)
                            .update(payload + salt)
                            .digest('hex');

            // Generate NCN: SHORT-YEAR-HEX
            const ncn = `${institution.short_code}-${student.year}-${randomBytes(4).toString('hex').toUpperCase()}`;

            // 3. Save to Neon
            await sql`
                INSERT INTO credentials (institution_id, ncn, student_name, matric_number, grad_year, course_name, degree_type, salt, blockchain_hash)
                VALUES (${institution.id}, ${ncn}, ${student.name}, ${student.matric}, ${student.year}, ${student.course}, ${student.type}, ${salt}, ${hash})
            `;

            results.push({ ncn, hash, name: student.name });
        }

        // 4. Blockchain Anchoring (if contract is configured)
        let txHashes = [];
        if (process.env.CONTRACT_ADDRESS && process.env.ALCHEMY_RPC_URL) {
            try {
                const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
                const wallet = new ethers.Wallet(process.env.INSTITUTION_PRIVATE_KEY || '', provider);
                const contract = new ethers.Contract(
                    process.env.CONTRACT_ADDRESS,
                    ['function anchorCredential(bytes32 _hash) external'],
                    wallet
                );

                for (const r of results) {
                    const tx = await contract.anchorCredential('0x' + r.hash);
                    const receipt = await tx.wait();
                    txHashes.push({ ncn: r.ncn, txHash: receipt.hash });
                }
            } catch (chainError) {
                console.error('ACV_CHAIN_ANCHOR_WARNING:', chainError.message);
                // Non-blocking: DB records exist, anchoring can be retried
            }
        }

        // 5. Update Quota Count
        await sql`
            UPDATE institutions 
            SET issued_count = issued_count + ${batch.length} 
            WHERE id = ${institution.id}
        `;

        // 6. Audit Log
        await sql`
            INSERT INTO audit_logs (action, actor_id, metadata)
            VALUES ('batch_issue', ${institution.id}, ${JSON.stringify({ count: batch.length, ncn_count: results.length })}) 
        `.catch(e => console.error('AUDIT_LOG_WARN:', e.message));

        return res.status(200).json({ 
            success: true, 
            results,
            txHashes: txHashes.length > 0 ? txHashes : undefined,
            message: txHashes.length > 0 
                ? 'Batch synthesized, saved, and anchored on-chain.' 
                : 'Batch synthesized and saved. Configure CONTRACT_ADDRESS and ALCHEMY_RPC_URL to enable on-chain anchoring.'
        });

    } catch (error) {
        console.error('ACV_ISSUE_ERROR:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
