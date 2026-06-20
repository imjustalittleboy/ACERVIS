// ACERVIS API: Verification Logic (v3.0.0)
import { createHmac } from 'crypto';
import { ethers } from 'ethers';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(200).end();
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { ncn } = req.query;
    if (!ncn) return res.status(400).json({ error: 'NCN required' });

    try {
        const sql = neon(process.env.DATABASE_URL);

        // 1. Fetch metadata from Neon
        const [record] = await sql`
            SELECT c.*, i.name as institution_name, i.seal_blob_url, i.short_code
            FROM credentials c 
            JOIN institutions i ON c.institution_id = i.id 
            WHERE c.ncn = ${ncn}
        `;

        if (!record) {
            // Audit: log not-found
            await sql`
                INSERT INTO audit_logs (action, metadata, ip_address)
                VALUES ('verify_not_found', ${JSON.stringify({ ncn })}, ${req.headers['x-forwarded-for'] || req.socket.remoteAddress || null})
            `.catch(() => {});
            return res.status(200).json({ state: 'NOT_FOUND' });
        }

        // 2. Local Synthesis (Verify Integrity)
        const payload = `${record.student_name}|${record.grad_year}|${record.course_name}|${record.degree_type}|${record.matric_number}`.toLowerCase();
        const pepper = process.env.PROTOCOL_PEPPER;
        const localHash = createHmac('sha256', pepper)
                            .update(payload + record.salt)
                            .digest('hex');

        if (localHash !== record.blockchain_hash) {
            // Audit: log tamper detection
            await sql`
                INSERT INTO audit_logs (action, target_id, metadata, ip_address)
                VALUES ('verify_tampered', ${record.id}, ${JSON.stringify({ ncn, reason: 'Hash mismatch' })}, ${req.headers['x-forwarded-for'] || req.socket.remoteAddress || null})
            `.catch(() => {});
            return res.status(200).json({ state: 'TAMPERED', metadata: record });
        }

        // 3. Blockchain Verification (Polygon Amoy)
        if (process.env.CONTRACT_ADDRESS && process.env.ALCHEMY_RPC_URL) {
            try {
                const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
                const contract = new ethers.Contract(
                    process.env.CONTRACT_ADDRESS,
                    ['function verify(bytes32 _hash) view returns (uint8, uint256, address)'],
                    provider
                );

                const [status, anchoredAt, issuedBy] = await contract.verify('0x' + localHash);
                
                // Status mapping: 0=NonExistent, 1=Active, 2=Suspended, 3=Revoked
                const states = ['NOT_FOUND', 'VERIFIED', 'SUSPENDED', 'REVOKED'];
                const mappedState = states[status] || 'NOT_FOUND';

                // Map DB status to blockchain state for consistency
                let effectiveState = mappedState;
                if (mappedState === 'VERIFIED' && record.status === 'revoked') {
                    effectiveState = 'REVOKED';
                } else if (mappedState === 'VERIFIED' && record.status === 'suspended') {
                    effectiveState = 'SUSPENDED';
                }

                // Audit: log successful verification
                await sql`
                    INSERT INTO audit_logs (action, target_id, metadata, ip_address)
                    VALUES ('verify_' + ${effectiveState.toLowerCase()}, ${record.id}, ${JSON.stringify({ ncn, state: effectiveState })}, ${req.headers['x-forwarded-for'] || req.socket.remoteAddress || null})
                `.catch(() => {});

                return res.status(200).json({
                    state: effectiveState,
                    metadata: record,
                    blockchain: {
                        anchoredAt: Number(anchoredAt),
                        issuedBy
                    }
                });
            } catch (chainError) {
                console.error('ACV_CHAIN_VERIFY_ERROR:', chainError.message);
                // Fallback: return DB-only verification
                return res.status(200).json({
                    state: record.status === 'revoked' ? 'REVOKED' : record.status === 'suspended' ? 'SUSPENDED' : 'VERIFIED',
                    metadata: record,
                    blockchain: null,
                    warning: 'Blockchain verification unavailable. Result based on database state only.'
                });
            }
        }

        // 4. No blockchain configured — DB-only verification
        const dbState = record.status === 'revoked' ? 'REVOKED' : record.status === 'suspended' ? 'SUSPENDED' : 'VERIFIED';

        await sql`
            INSERT INTO audit_logs (action, target_id, metadata, ip_address)
            VALUES ('verify_' + ${dbState.toLowerCase()}, ${record.id}, ${JSON.stringify({ ncn, state: dbState })}, ${req.headers['x-forwarded-for'] || req.socket.remoteAddress || null})
        `.catch(() => {});

        return res.status(200).json({
            state: dbState,
            metadata: record,
            blockchain: null,
            warning: 'Blockchain verification not configured. Result based on database state.'
        });

    } catch (error) {
        console.error('ACV_VERIFY_ERROR:', error);
        await sql`
            INSERT INTO audit_logs (action, metadata)
            VALUES ('verify_error', ${JSON.stringify({ ncn, error: error.message })})
        `.catch(() => {});
        return res.status(500).json({ error: 'Internal server error', code: 'ACV_500' });
    }
}
