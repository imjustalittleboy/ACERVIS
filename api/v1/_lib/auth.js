// ACERVIS: Authentication Helpers
import { getDb } from './db.js';

// Authenticate institution by token_id from x-institution-token header
export async function authenticateInstitution(req) {
  const token = req.headers['x-institution-token'];
  if (!token) return null;

  const sql = getDb();
  const [inst] = await sql`
    SELECT id, name, short_code, type, issuance_quota, issued_count, 
           is_active, wallet_address, admin_email
    FROM institutions 
    WHERE token_id = ${token} AND is_active = TRUE
  `;
  return inst || null;
}

// Verify super admin secret from x-super-admin-secret header
export function verifySuperAdmin(req) {
  const secret = req.headers['x-super-admin-secret'];
  return secret && secret === process.env.SUPER_ADMIN_SECRET;
}

// Get client IP
export function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.headers['x-real-ip'] 
    || req.socket?.remoteAddress 
    || 'unknown';
}
