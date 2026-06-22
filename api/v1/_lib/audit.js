// ACERVIS: Audit Logging Helper
import { getDb } from './db.js';
import { getClientIp } from './auth.js';

export async function logAudit(action, actorId = null, targetId = null, metadata = {}, req = null) {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO audit_logs (action, actor_id, target_id, metadata, ip_address)
      VALUES (
        ${action}, 
        ${actorId}, 
        ${targetId}, 
        ${JSON.stringify(metadata)}, 
        ${req ? getClientIp(req) : null}
      )
    `;
  } catch (err) {
    console.error('ACV_AUDIT_WARN:', err.message);
  }
}
