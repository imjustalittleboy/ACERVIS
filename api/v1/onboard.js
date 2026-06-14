// ACERVIS API: Onboarding & Governance (v3.0.0)
import { randomBytes } from 'crypto';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Super Admin Secret Check (Basic implementation)
    const adminSecret = req.headers['x-super-admin-secret'];
    if (adminSecret !== process.env.SUPER_ADMIN_SECRET) {
        return res.status(403).json({ error: 'Unauthorized Governance Action' });
    }

    const { name, short_code, type, quota, email, wallet } = req.body;
    if (!name || !short_code || !type || !quota || !email) {
        return res.status(400).json({ error: 'Incomplete onboarding data' });
    }

    try {
        const sql = neon(process.env.DATABASE_URL);

        // Generate a 12-byte alphanumeric institutional token
        const token = randomBytes(6).toString('hex').toUpperCase();

        const [institution] = await sql`
            INSERT INTO institutions (name, short_code, type, token_id, issuance_quota, admin_email, wallet_address)
            VALUES (${name}, ${short_code}, ${type}, ${token}, ${quota}, ${email}, ${wallet})
            RETURNING id, token_id
        `;

        return res.status(201).json({
            success: true,
            institution_id: institution.id,
            token_id: institution.token_id,
            message: 'Institution onboarded successfully. Provide the Token ID to the university registrar.'
        });

    } catch (error) {
        console.error('ACV_ONBOARD_ERROR:', error);
        if (error.code === '23505') return res.status(409).json({ error: 'Institution or Short Code already exists' });
        return res.status(500).json({ error: 'Internal server error' });
    }
}
