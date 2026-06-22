// ACERVIS: Blockchain Utility API (v3.1.0)
// GET  /api/v1/blockchain         — Status check (network, contract, balance)
// POST /api/v1/blockchain?action=anchor-pending — Retry anchoring for unanchored records
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';
import { logAudit } from './_lib/audit.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, POST, OPTIONS');

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);

    if (!institution && !isSuperAdmin) {
      return error(res, 'ACV_401', 'Authentication required', 401);
    }

    // ── GET: Status Check ──
    if (req.method === 'GET') {
      const status = {
        configured: false,
        network: null,
        contract: null,
        wallet: null,
        pending: 0
      };

      if (process.env.ALCHEMY_RPC_URL && process.env.CONTRACT_ADDRESS) {
        status.configured = true;
        status.network = {
          rpc: process.env.ALCHEMY_RPC_URL.slice(0, 40) + '...',
          contract: process.env.CONTRACT_ADDRESS,
          chain: 'Polygon Amoy (80002)'
        };

        try {
          const { ethers } = await import('ethers');
          const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
          const network = await provider.getNetwork();
          status.network.chain_id = Number(network.chainId);
          status.network.connected = true;

          // Check contract
          const code = await provider.getCode(process.env.CONTRACT_ADDRESS);
          status.contract = { deployed: code !== '0x', address: process.env.CONTRACT_ADDRESS };

          // Check wallet balance if private key available
          if (process.env.INSTITUTION_PRIVATE_KEY) {
            const wallet = new ethers.Wallet(process.env.INSTITUTION_PRIVATE_KEY, provider);
            const balance = await provider.getBalance(wallet.address);
            status.wallet = {
              address: wallet.address,
              balance: ethers.formatEther(balance)
            };
          }
        } catch (e) {
          status.network.connected = false;
          status.network.error = e.message;
        }
      }

      // Count pending records
      const instId = institution?.id || null;
      if (instId) {
        const [cred] = await sql`
          SELECT COUNT(*) FROM credentials 
          WHERE institution_id = ${instId} AND tx_hash IS NULL
        `;
        const [trans] = await sql`
          SELECT COUNT(*) FROM transcripts 
          WHERE institution_id = ${instId} AND tx_hash IS NULL
        `;
        status.pending = parseInt(cred.count, 10) + parseInt(trans.count, 10);
        status.pending_credentials = parseInt(cred.count, 10);
        status.pending_transcripts = parseInt(trans.count, 10);
      }

      return res.status(200).json(status);
    }

    // ── POST: Anchor Pending Records ──
    if (req.method === 'POST') {
      if (!process.env.CONTRACT_ADDRESS || !process.env.ALCHEMY_RPC_URL) {
        return error(res, 'ACV_400', 'Blockchain not configured. Set CONTRACT_ADDRESS and ALCHEMY_RPC_URL.');
      }

      if (!process.env.INSTITUTION_PRIVATE_KEY) {
        return error(res, 'ACV_400', 'INSTITUTION_PRIVATE_KEY not configured');
      }

      const instId = institution?.id;
      if (!instId) return error(res, 'ACV_401', 'Institution authentication required', 401);

      // Get unanchored credentials
      const pendingCreds = await sql`
        SELECT ncn, blockchain_hash FROM credentials 
        WHERE institution_id = ${instId} AND tx_hash IS NULL
        LIMIT 500
      `;

      const pendingTrans = await sql`
        SELECT ncn, blockchain_hash FROM transcripts 
        WHERE institution_id = ${instId} AND tx_hash IS NULL
        LIMIT 500
      `;

      if (pendingCreds.length === 0 && pendingTrans.length === 0) {
        return res.status(200).json({ success: true, message: 'No pending records to anchor' });
      }

      const { ethers } = await import('ethers');
      const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
      const wallet = new ethers.Wallet(process.env.INSTITUTION_PRIVATE_KEY, provider);
      const contract = new ethers.Contract(
        process.env.CONTRACT_ADDRESS,
        ['function anchorCredential(bytes32 _hash) external'],
        wallet
      );

      const anchored = [];

      for (const cred of pendingCreds) {
        try {
          const tx = await contract.anchorCredential('0x' + cred.blockchain_hash);
          const receipt = await tx.wait();
          await sql`UPDATE credentials SET tx_hash = ${receipt.hash}, anchored_at = NOW() WHERE ncn = ${cred.ncn}`;
          anchored.push({ ncn: cred.ncn, type: 'credential', tx_hash: receipt.hash });
        } catch (e) {
          console.error('ANCHOR_ERR:', cred.ncn, e.message);
        }
      }

      for (const trans of pendingTrans) {
        try {
          const tx = await contract.anchorCredential('0x' + trans.blockchain_hash);
          const receipt = await tx.wait();
          await sql`UPDATE transcripts SET tx_hash = ${receipt.hash}, anchored_at = NOW() WHERE ncn = ${trans.ncn}`;
          anchored.push({ ncn: trans.ncn, type: 'transcript', tx_hash: receipt.hash });
        } catch (e) {
          console.error('ANCHOR_ERR:', trans.ncn, e.message);
        }
      }

      await logAudit('blockchain_anchor_retry', instId, null, {
        anchored: anchored.length,
        failed_credentials: pendingCreds.length,
        failed_transcripts: pendingTrans.length
      }, req);

      return res.status(200).json({
        success: true,
        anchored: anchored.length,
        pending_remaining: (pendingCreds.length + pendingTrans.length) - anchored.length,
        results: anchored
      });
    }

    return error(res, 'ACV_405', 'Method not allowed', 405);

  } catch (err) {
    console.error('ACV_BLOCKCHAIN_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
