// ACERVIS: Institution Management (Consolidated v3.1.0)
// GET    /api/v1/institutions         — List all (super admin)
// GET    /api/v1/institutions?id=X    — Single institution details + wallet
// POST   /api/v1/institutions         — Onboard new (generates wallet, super admin)
// PUT    /api/v1/institutions?id=X    — Update institution (super admin)
// PATCH  /api/v1/institutions?id=X&action=quota|status — Partial update (super admin)
// DELETE /api/v1/institutions?id=X    — Deactivate (super admin)
import { randomBytes } from 'crypto';
import { handlePreflight, error } from './_lib/cors.js';
import { getDb, exec } from './_lib/db.js';
import { verifySuperAdmin } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';
import { generateInstitutionWallet } from './_lib/crypto.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

  try {
    const sql = getDb();

    // ── GET: List or Single ──
    if (req.method === 'GET') {
      const { id, page, limit, search, status } = req.query;

      if (id) {
        const [inst] = await sql`
          SELECT i.*,
            (SELECT COUNT(*) FROM credentials WHERE institution_id = i.id) AS credentials_count,
            (SELECT COUNT(*) FROM transcripts WHERE institution_id = i.id) AS transcripts_count,
            (SELECT COUNT(*) FROM credentials WHERE institution_id = i.id AND status = 'active') AS active_count,
            (SELECT COUNT(*) FROM credentials WHERE institution_id = i.id AND status = 'revoked') AS revoked_count
          FROM institutions i WHERE i.id = ${id}
        `;
        if (!inst) return error(res, 'ACV_404', 'Institution not found', 404);

        const recentActivity = await sql`
          SELECT action, metadata, created_at FROM audit_logs 
          WHERE actor_id = ${id} ORDER BY created_at DESC LIMIT 10
        `;
        const monthlyTrend = await sql`
          SELECT DATE_TRUNC('month', issued_at) AS month, COUNT(*) AS count
          FROM credentials WHERE institution_id = ${id} AND issued_at > NOW() - INTERVAL '6 months'
          GROUP BY month ORDER BY month
        `;
        return res.status(200).json({ ...inst, recent_activity: recentActivity, monthly_trend: monthlyTrend });
      }

      const p = parseInt(page, 10) || 1;
      const l = Math.min(parseInt(limit, 10) || 20, 100);
      const offset = (p - 1) * l;
      const clauses = [`TRUE`];
      const sparams = [];
      if (search) {
        const s = `%${search}%`;
        clauses.push(`(i.name ILIKE $${sparams.length + 1} OR i.short_code ILIKE $${sparams.length + 2})`);
        sparams.push(s, s);
      }
      if (status === 'active') clauses.push(`i.is_active = TRUE`);
      if (status === 'inactive') clauses.push(`i.is_active = FALSE`);
      const iwhere = clauses.join(' AND ');

      const [{ count }] = await exec(sql, `SELECT COUNT(*) FROM institutions i WHERE ${iwhere}`, sparams);
      const rows = await exec(sql,
        `SELECT i.*,
          (SELECT COUNT(*) FROM credentials WHERE institution_id = i.id) AS credentials_count,
          (SELECT COUNT(*) FROM transcripts WHERE institution_id = i.id) AS transcripts_count
        FROM institutions i WHERE ${iwhere} ORDER BY i.created_at DESC LIMIT ${l} OFFSET ${offset}`,
        sparams
      );
      return res.status(200).json({ institutions: rows, pagination: { page: p, limit: l, total: parseInt(count, 10), totalPages: Math.ceil(parseInt(count, 10) / l) } });
    }

    // ── POST: Onboard (generates wallet, stores encrypted key) ──
    if (req.method === 'POST') {
      if (!verifySuperAdmin(req)) return error(res, 'ACV_403', 'Super Admin access required', 403);
      const { name, short_code, type, quota, email, wallet } = req.body;
      if (!name || !short_code || !type || !quota || !email)
        return error(res, 'ACV_400', 'Required: name, short_code, type, quota, email');

      const token = randomBytes(6).toString('hex').toUpperCase();

      // Generate wallet for this institution
      let walletAddress = wallet || null;
      let encryptedKey = null;
      try {
        const genWallet = await generateInstitutionWallet();
        walletAddress = genWallet.address;
        encryptedKey = genWallet.encryptedKey;
      } catch (e) {
        console.error('WALLET_GEN_WARN:', e.message);
        // Non-blocking: institution can connect wallet later
      }

      // Insert with or without encrypted_private_key (in case column hasn't been added yet)
      let inst;
      try {
        [inst] = await sql`
          INSERT INTO institutions (name, short_code, type, token_id, issuance_quota, admin_email, wallet_address, encrypted_private_key)
          VALUES (${name}, ${short_code.toUpperCase()}, ${type}, ${token}, ${quota}, ${email}, ${walletAddress}, ${encryptedKey})
          RETURNING id, token_id, name AS institution_name
        `;
      } catch (insertErr) {
        // Fallback if encrypted_private_key column doesn't exist
        if (insertErr.message && insertErr.message.includes('encrypted_private_key')) {
          [inst] = await sql`
            INSERT INTO institutions (name, short_code, type, token_id, issuance_quota, admin_email, wallet_address)
            VALUES (${name}, ${short_code.toUpperCase()}, ${type}, ${token}, ${quota}, ${email}, ${walletAddress})
            RETURNING id, token_id, name AS institution_name
          `;
        } else {
          throw insertErr;
        }
      }
      // Auto-authorize wallet on smart contract if contract is configured
      let authorizedOnChain = false;
      let authTxHash = null;
      if (walletAddress && process.env.CONTRACT_ADDRESS && process.env.ALCHEMY_RPC_URL) {
        try {
          const { ethers } = await import('ethers');
          const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
          const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
          const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS,
            ['function authorizeInstitution(address,string,uint256)'], deployer);
          const tx = await contract.authorizeInstitution(walletAddress, name, quota);
          const receipt = await tx.wait();
          authorizedOnChain = true;
          authTxHash = receipt.hash;
        } catch (e) {
          console.error('AUTO_AUTHORIZE_WARN:', e.message);
        }
      }

      await logAudit('institution_onboarded', null, inst.id, { name, short_code, type, quota, wallet: walletAddress, authorized_on_chain: authorizedOnChain }, req);
      return res.status(201).json({
        success: true,
        institution_id: inst.id,
        token_id: inst.token_id,
        wallet_address: walletAddress,
        authorized_on_chain: authorizedOnChain,
        auth_tx_hash: authTxHash,
        warnings: !authorizedOnChain && walletAddress ? ['Wallet generated but not authorized on-chain. Use /api/v1/institutions?action=authorize-contract or run Super Admin setup.'] : undefined,
        message: walletAddress
          ? `Institution onboarded. Token ID: ${inst.token_id}. ${authorizedOnChain ? 'Wallet authorized on-chain.' : 'Authorize wallet on smart contract to enable anchoring.'}`
          : 'Institution onboarded. No wallet generated — connect one later.'
      });
    }

    // ── PUT: Update ──
    if (req.method === 'PUT') {
      if (!verifySuperAdmin(req)) return error(res, 'ACV_403', 'Super Admin access required', 403);
      const id = req.query.id;
      if (!id) return error(res, 'ACV_400', 'Institution ID required');
      const { name, short_code, type, quota, email, wallet } = req.body;
      const [inst] = await sql`
        UPDATE institutions SET name=COALESCE(${name},name), short_code=COALESCE(${short_code},short_code), type=COALESCE(${type},type), issuance_quota=COALESCE(${quota},issuance_quota), admin_email=COALESCE(${email},admin_email), wallet_address=COALESCE(${wallet},wallet_address) WHERE id=${id} RETURNING *
      `;
      if (!inst) return error(res, 'ACV_404', 'Not found', 404);
      await logAudit('institution_updated', null, id, { updates: req.body }, req);
      return res.status(200).json({ success: true, institution: inst });
    }

    // ── PATCH: Quota or Status ──
    if (req.method === 'PATCH') {
      if (!verifySuperAdmin(req)) return error(res, 'ACV_403', 'Super Admin access required', 403);
      const id = req.query.id;
      if (!id) return error(res, 'ACV_400', 'Institution ID required');
      const { action } = req.query;

      if (action === 'quota') {
        const { quota } = req.body;
        if (!quota || quota < 0) return error(res, 'ACV_400', 'Valid quota required');
        const [inst] = await sql`UPDATE institutions SET issuance_quota=${quota},last_activity_at=NOW() WHERE id=${id} RETURNING id,name,issuance_quota,issued_count`;
        if (!inst) return error(res, 'ACV_404', 'Not found', 404);
        await logAudit('quota_updated', null, id, { new_quota: quota }, req);
        return res.status(200).json({ success: true, institution: inst });
      }

      if (action === 'authorize-contract') {
        if (!process.env.CONTRACT_ADDRESS || !process.env.ALCHEMY_RPC_URL)
          return error(res, 'ACV_400', 'Blockchain not configured. Set CONTRACT_ADDRESS and ALCHEMY_RPC_URL.');
        const [inst] = await sql`SELECT id, name, wallet_address, issuance_quota FROM institutions WHERE id=${id}`;
        if (!inst) return error(res, 'ACV_404', 'Not found', 404);
        if (!inst.wallet_address) return error(res, 'ACV_400', 'Institution has no wallet. Generate one first.');
        try {
          const { ethers } = await import('ethers');
          const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
          const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
          const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS,
            ['function authorizeInstitution(address,string,uint256)',
             'function institutions(address) view returns(bool,uint256,uint256,string)'], deployer);

          // Check if already authorized
          try {
            const [isAuth] = await contract.institutions(inst.wallet_address);
            if (isAuth)
              return res.status(200).json({ success: true, message: 'Already authorized on-chain', wallet_address: inst.wallet_address });
          } catch (e) { /* proceed */ }

          const tx = await contract.authorizeInstitution(inst.wallet_address, inst.name, inst.issuance_quota);
          const receipt = await tx.wait();
          await logAudit('institution_authorized_on_chain', null, id, { wallet_address: inst.wallet_address, tx_hash: receipt.hash }, req);
          return res.status(200).json({
            success: true,
            message: `Wallet ${inst.wallet_address} authorized on-chain. Quota: ${inst.issuance_quota}`,
            tx_hash: receipt.hash,
            wallet_address: inst.wallet_address
          });
        } catch (e) {
          console.error('AUTHORIZE_ERR:', e.message);
          return error(res, 'ACV_500', `Authorize failed: ${e.message}`, 500);
        }
      }

      if (action === 'status') {
        const { is_active } = req.body;
        if (typeof is_active !== 'boolean') return error(res, 'ACV_400', 'is_active (boolean) required');
        const [inst] = await sql`UPDATE institutions SET is_active=${is_active},last_activity_at=NOW() WHERE id=${id} RETURNING id,name,is_active`;
        if (!inst) return error(res, 'ACV_404', 'Not found', 404);

        // When deactivating, cascade-revoke all active credentials and transcripts
        if (!is_active) {
          await sql`UPDATE credentials SET status='revoked' WHERE institution_id=${id} AND status='active'`;
          await sql`UPDATE transcripts SET status='revoked' WHERE institution_id=${id} AND status='active'`;
        }

        await logAudit(is_active ? 'institution_reactivated' : 'institution_deactivated', null, id, {}, req);
        return res.status(200).json({ success: true, message: is_active ? 'Institution reactivated' : 'Institution deactivated. All active credentials and transcripts have been revoked.', institution: inst });
      }

      return error(res, 'ACV_400', 'Invalid action. Use: authorize-contract, quota, status');
    }

    // ── DELETE: Deactivate ──
    if (req.method === 'DELETE') {
      if (!verifySuperAdmin(req)) return error(res, 'ACV_403', 'Super Admin access required', 403);
      const id = req.query.id;
      if (!id) return error(res, 'ACV_400', 'Institution ID required');
      const [inst] = await sql`UPDATE institutions SET is_active=FALSE,last_activity_at=NOW() WHERE id=${id} RETURNING id,name`;
      if (!inst) return error(res, 'ACV_404', 'Not found', 404);
      await sql`UPDATE credentials SET status='revoked' WHERE institution_id=${id} AND status='active'`;
      await sql`UPDATE transcripts SET status='revoked' WHERE institution_id=${id} AND status='active'`;
      await logAudit('institution_deactivated', null, id, {}, req);
      return res.status(200).json({ success: true, message: 'Institution deactivated. All credentials revoked.' });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);
  } catch (err) {
    console.error('ACV_INST_ERROR:', err);
    if (err.code === '23505') return error(res, 'ACV_409', 'Duplicate entry', 409);
    console.error('ACV_INST_ERROR_DETAIL:', err.message, err.stack?.slice(0, 300));
    return error(res, 'ACV_500', err.message || 'Internal server error', 500);
  }
}
