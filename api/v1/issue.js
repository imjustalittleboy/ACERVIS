// ACERVIS API: Batch Issuance & Hashing (v3.0.0)
import { createHmac, randomBytes } from 'crypto';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { token, batch } = req.body;
    if (!token || !batch) return res.status(400).json({ error: 'Missing token or batch' });

    try {
        const sql = neon(process.env.DATABASE_URL);

        // 1. Authenticate Institution & Check Quota
        const [institution] = await sql`
            SELECT id, issuance_quota, issued_count, short_code 
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

            // Generate 16-digit NCN: SHORT-YEAR-RANDOM
            const ncn = `${institution.short_code}-${student.year}-${randomBytes(4).toString('hex').toUpperCase()}`;

            // 3. Save to Neon
            await sql`
                INSERT INTO credentials (institution_id, ncn, student_name, matric_number, grad_year, course_name, degree_type, salt, blockchain_hash)
                VALUES (${institution.id}, ${ncn}, ${student.name}, ${student.matric}, ${student.year}, ${student.course}, ${student.type}, ${salt}, ${hash})
            `;

            results.push({ ncn, hash, name: student.name });
        }

        // 4. Update Quota Count
        await sql`
            UPDATE institutions 
            SET issued_count = issued_count + ${batch.length} 
            WHERE id = ${institution.id}
        `;

        return res.status(200).json({ 
            success: true, 
            results,
            message: 'Batch synthesized and saved. Proceed to anchor hashes on-chain.'
        });

    } catch (error) {
        console.error('ACV_ISSUE_ERROR:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
