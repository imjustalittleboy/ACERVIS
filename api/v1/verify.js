// ACERVIS API: Verification Logic (v3.0.0)
import { createHmac } from 'crypto';
import { ethers } from 'ethers';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { ncn } = req.query;
    if (!ncn) return res.status(400).json({ error: 'NCN required' });

    try {
        const sql = neon(process.env.DATABASE_URL);
        
        // 1. Fetch metadata from Neon
        const [record] = await sql`
            SELECT c.*, i.name as institution_name, i.seal_blob_url 
            FROM credentials c 
            JOIN institutions i ON c.institution_id = i.id 
            WHERE c.ncn = ${ncn}
        `;

        if (!record) return res.status(404).json({ state: 'NOT_FOUND' });

        // 2. Local Synthesis (Verify Integrity)
        const payload = `${record.student_name}|${record.grad_year}|${record.course_name}|${record.degree_type}|${record.matric_number}`.toLowerCase();
        const pepper = process.env.PROTOCOL_PEPPER;
        const localHash = createHmac('sha256', pepper)
                            .update(payload + record.salt)
                            .digest('hex');

        if (localHash !== record.blockchain_hash) {
            return res.status(200).json({ state: 'TAMPERED', metadata: record });
        }

        // 3. Blockchain Verification (Polygon Amoy)
        const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
        const contract = new ethers.Contract(
            process.env.CONTRACT_ADDRESS,
            ['function verify(bytes32 _hash) view returns (uint8, uint256, address)'],
            provider
        );

        const [status, anchoredAt, issuedBy] = await contract.verify('0x' + localHash);
        
        // Status mapping: 0=NonExistent, 1=Active, 2=Suspended, 3=Revoked
        const states = ['NOT_FOUND', 'VERIFIED', 'SUSPENDED', 'REVOKED'];

        return res.status(200).json({
            state: states[status],
            metadata: record,
            blockchain: {
                anchoredAt: Number(anchoredAt),
                issuedBy
            }
        });

    } catch (error) {
        console.error('ACV_VERIFY_ERROR:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
