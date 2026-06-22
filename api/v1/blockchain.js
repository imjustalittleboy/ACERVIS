// ACERVIS: Blockchain Utility (v3.1.0)
// GET  /api/v1/blockchain                        — Status (network, contract, institution wallet balance)
// POST /api/v1/blockchain?action=anchor-pending   — Retry anchoring for unanchored records (institution)
// POST /api/v1/blockchain?action=fund-gas         — Distribute POL to all institution wallets (super admin)
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';
import { walletFromInstitution, decryptPrivateKey } from './_lib/crypto.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, POST, OPTIONS');

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);

    if (!institution && !isSuperAdmin) return error(res, 'ACV_401', 'Authentication required', 401);

    // ── GET: Status ──
    if (req.method === 'GET') {
      const { ethers } = await import('ethers');
      const status = { configured: false, network: null, contract: null, wallet: null, pending: 0 };

      if (process.env.ALCHEMY_RPC_URL && process.env.CONTRACT_ADDRESS) {
        status.configured = true;
        const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
        try {
          const network = await provider.getNetwork();
          const code = await provider.getCode(process.env.CONTRACT_ADDRESS);
          status.network = { connected: true, chain_id: Number(network.chainId), chain: 'Polygon Amoy' };
          status.contract = { deployed: code !== '0x', address: process.env.CONTRACT_ADDRESS };
        } catch (e) {
          status.network = { connected: false, error: e.message };
        }

        // Show institution's own wallet balance if they have one
        if (institution) {
          const [row] = await sql`SELECT wallet_address, encrypted_private_key FROM institutions WHERE id = ${institution.id}`;
          if (row?.wallet_address) {
            try {
              const bal = await provider.getBalance(row.wallet_address);
              status.wallet = { address: row.wallet_address, balance: ethers.formatEther(bal) };
            } catch (e) { status.wallet = { address: row.wallet_address, balance: '?', error: e.message }; }
          }
          // Count pending records
          const [cred] = await sql`SELECT COUNT(*) FROM credentials WHERE institution_id=${institution.id} AND tx_hash IS NULL`;
          const [trans] = await sql`SELECT COUNT(*) FROM transcripts WHERE institution_id=${institution.id} AND tx_hash IS NULL`;
          status.pending = parseInt(cred.count,10) + parseInt(trans.count,10);
        }
      }
      return res.status(200).json(status);
    }

    if (req.method !== 'POST') return error(res, 'ACV_405', 'Method not allowed', 405);

    const { action } = req.query;
    const { ethers } = await import('ethers');

    // ── POST: Anchor Pending (institution uses own wallet) ──
    if (action === 'anchor-pending') {
      if (!process.env.CONTRACT_ADDRESS || !process.env.ALCHEMY_RPC_URL)
        return error(res, 'ACV_400', 'Blockchain not configured');

      const instId = institution?.id;
      if (!instId) return error(res, 'ACV_401', 'Institution auth required', 401);

      const [row] = await sql`SELECT encrypted_private_key FROM institutions WHERE id=${instId}`;
      if (!row?.encrypted_private_key) return error(res, 'ACV_400', 'No wallet configured for this institution. Re-onboard or set wallet manually.');

      const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
      let wallet;
      try { wallet = await walletFromInstitution(provider, row.encrypted_private_key); }
      catch (e) { return error(res, 'ACV_500', 'Failed to decrypt wallet key', 500); }

      const pendingCreds = await sql`SELECT ncn,blockchain_hash FROM credentials WHERE institution_id=${instId} AND tx_hash IS NULL LIMIT 500`;
      const pendingTrans = await sql`SELECT ncn,blockchain_hash FROM transcripts WHERE institution_id=${instId} AND tx_hash IS NULL LIMIT 500`;

      if (!pendingCreds.length && !pendingTrans.length)
        return res.status(200).json({ success: true, message: 'No pending records' });

      const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS,
        ['function anchorCredential(bytes32) external'], wallet);
      const anchored = [];

      for (const r of pendingCreds) {
        try {
          const tx = await contract.anchorCredential('0x' + r.blockchain_hash);
          const receipt = await tx.wait();
          await sql`UPDATE credentials SET tx_hash=${receipt.hash},anchored_at=NOW() WHERE ncn=${r.ncn}`;
          anchored.push({ ncn: r.ncn, type: 'credential', tx_hash: receipt.hash });
        } catch (e) { console.error('ANCHOR_ERR:', r.ncn, e.message); }
      }
      for (const r of pendingTrans) {
        try {
          const tx = await contract.anchorCredential('0x' + r.blockchain_hash);
          const receipt = await tx.wait();
          await sql`UPDATE transcripts SET tx_hash=${receipt.hash},anchored_at=NOW() WHERE ncn=${r.ncn}`;
          anchored.push({ ncn: r.ncn, type: 'transcript', tx_hash: receipt.hash });
        } catch (e) { console.error('ANCHOR_ERR:', r.ncn, e.message); }
      }

      await logAudit('blockchain_anchor_retry', instId, null, { anchored: anchored.length }, req);
      return res.status(200).json({ success: true, anchored: anchored.length, pending_remaining: (pendingCreds.length + pendingTrans.length) - anchored.length, results: anchored });
    }

    // ── POST: Fund Gas (super admin distributes POL to all institution wallets) ──
    if (action === 'fund-gas') {
      if (!isSuperAdmin) return error(res, 'ACV_403', 'Super Admin access required', 403);
      if (!process.env.ALCHEMY_RPC_URL || !process.env.PRIVATE_KEY)
        return error(res, 'ACV_400', 'ALCHEMY_RPC_URL and PRIVATE_KEY (deployer) required');

      const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
      const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
      const deployerBal = await provider.getBalance(deployer.address);

      if (deployerBal === 0n) return error(res, 'ACV_400', 'Deployer wallet has zero POL');

      const amount = req.body?.amount || '0.01'; // POL per institution
      const amountWei = ethers.parseEther(String(amount));

      const institutions = await sql`
        SELECT id, name, wallet_address, encrypted_private_key FROM institutions 
        WHERE wallet_address IS NOT NULL AND is_active = TRUE
      `;

      if (!institutions.length) return res.status(200).json({ success: true, message: 'No institution wallets to fund' });

      const funded = [];
      for (const inst of institutions) {
        try {
          const bal = await provider.getBalance(inst.wallet_address);
          if (bal > ethers.parseEther('0.005')) {
            funded.push({ name: inst.name, address: inst.wallet_address, balance: ethers.formatEther(bal), skipped: true, reason: 'Already has sufficient balance' });
            continue;
          }
          const tx = await deployer.sendTransaction({ to: inst.wallet_address, value: amountWei });
          const receipt = await tx.wait();
          funded.push({ name: inst.name, address: inst.wallet_address, tx_hash: receipt.hash, amount, skipped: false });
        } catch (e) {
          funded.push({ name: inst.name, address: inst.wallet_address, skipped: true, reason: e.message });
        }
      }

      await logAudit('blockchain_fund_gas', null, null, { count: funded.filter(f => !f.skipped).length, total: funded.length, amount_per_wallet: amount }, req);
      return res.status(200).json({ success: true, summary: { funded: funded.filter(f => !f.skipped).length, skipped: funded.filter(f => f.skipped).length, total: funded.length }, results: funded });
    }

    return error(res, 'ACV_400', 'Invalid action. Use: anchor-pending, fund-gas');
  } catch (err) {
    console.error('ACV_BLOCKCHAIN_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
