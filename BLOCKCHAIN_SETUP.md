# ACERVIS — Blockchain Setup Guide

This guide walks through everything you need to deploy and configure the ACERVIS smart contract on **Polygon Amoy Testnet**, create institutional wallets, and connect the backend to the blockchain.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Set Up a Wallet (MetaMask)](#2-set-up-a-wallet-metamask)
3. [Get Test POL Tokens](#3-get-test-pol-tokens)
4. [Configure Environment Variables](#4-configure-environment-variables)
5. [Deploy the Smart Contract](#5-deploy-the-smart-contract)
6. [Verify the Contract (Polygonscan)](#6-verify-the-contract-polygonscan)
7. [Institution Wallet System — Auto-Generated Per Institution](#7-institution-wallet-system--auto-generated-per-institution)
8. [Funding Institution Wallets with Gas](#8-funding-institution-wallets-with-gas)
9. [Test the Connection](#9-test-the-connection)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

Before starting, make sure you have:

- **Node.js** v18+ installed (`node --version`)
- **npm** installed (`npm --version`)
- A **MetaMask** wallet browser extension
- A free **Alchemy** account (or any Polygon Amoy RPC provider)
- A **Vercel** project set up for the ACERVIS backend
- A **Neon** Postgres database running with the schema applied

Install the Hardhat toolchain locally:

```bash
npm install
```

This installs `hardhat`, `@nomicfoundation/hardhat-toolbox`, `ethers`, and `dotenv`.

---

## 2. Set Up a Wallet (MetaMask)

You need two wallets:

1. **Deployer Wallet** — Owns the contract. Needs test POL for gas fees.
2. **Institution Wallet** — Authorized by the contract to anchor credential hashes on-chain.

### Create a Deployer Wallet

**Option A: MetaMask (recommended for first-timers)**

1. Install the [MetaMask](https://metamask.io) browser extension
2. Create a new wallet or use an existing one
3. Add **Polygon Amoy Testnet** to MetaMask:

| Field | Value |
|-------|-------|
| Network Name | Polygon Amoy |
| RPC URL | `https://polygon-amoy.g.alchemy.com/v2/YOUR-API-KEY` |
| Chain ID | `80002` |
| Currency Symbol | `POL` |
| Block Explorer | `https://amoy.polygonscan.com` |

4. Copy the wallet address from MetaMask

**Option B: Generate via CLI (for automated workflows)**

Run this to generate a wallet and output its credentials:

```bash
npx hardhat console --network amoy
```

Then in the console:

```javascript
const wallet = ethers.Wallet.createRandom();
console.log("Address:", wallet.address);
console.log("Private Key:", wallet.privateKey);
```

> ⚠ **Save the private key** — it cannot be recovered if lost.

### Export the Private Key from MetaMask

1. Open MetaMask → Click the three dots → **Account details**
2. Click **Export Private Key**
3. Enter your password and copy the key (starts with `0x`)

---

## 3. Get Test POL Tokens

The deployer wallet needs test POL to pay gas fees for deploying the contract.

### Faucets (free test tokens):

| Faucet | Link | Notes |
|--------|------|-------|
| Alchemy Faucet | [faucets.alchemy.com](https://faucets.alchemy.com/polygon-amoy) | Requires Alchemy account, most reliable |
| Polygon Faucet | [faucet.polygon.technology](https://faucet.polygon.technology) | Official Polygon faucet |

**Steps:**

1. Go to the faucet website
2. Connect or paste your deployer wallet address
3. Request test POL (usually 0.1–1 POL per request)
4. Wait 30–60 seconds for the transaction to confirm

**How much do you need?**

| Operation | Estimated Gas (POL) |
|-----------|-------------------|
| Deploy contract | ~0.01 POL |
| Authorize 1 institution | ~0.002 POL |
| Anchor 1000 hashes | ~0.5 POL |
| **Total (initial setup)** | **~0.02 POL** |

Request 0.5 POL to be safe — it's testnet and free.

### Verify the Balance

Check that your wallet received the test tokens:

```bash
node -e "
const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://polygon-amoy.g.alchemy.com/v2/YOUR-KEY');
provider.getBalance('YOUR_WALLET_ADDRESS').then(b => console.log('Balance:', ethers.formatEther(b), 'POL'));
"
```

---

## 4. Configure Environment Variables

Create a `.env` file in the project root by copying `.env.example`:

```bash
cp .env.example .env
```

Fill in your values:

```env
DATABASE_URL=postgresql://user:password@ep-xxxx.us-east-2.aws.neon.tech/acervis?sslmode=require

PROTOCOL_PEPPER=a6f8c2d1e9b4a73f8c2d1e9b4a73f8c2
SUPER_ADMIN_SECRET=your-super-secret-here

# --- Key Encryption ---
# Encrypts institution wallet private keys stored in the database.
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
INSTITUTION_KEY_ENCRYPTION_KEY=a6f8c2d1e9b4a73f8c2d1e9b4a73f8c2d1e9b4a73f8c2d1e9b4a73f8c2d1e9b4

# --- Blockchain ---
# Your deployer wallet's private key (used for Hardhat deployment + gas funding)
PRIVATE_KEY=0x...

# Your Alchemy RPC URL
ALCHEMY_RPC_URL=https://polygon-amoy.g.alchemy.com/v2/your-api-key

# Will be set after deployment
CONTRACT_ADDRESS=
```

> ⚠ **Security:** Never commit `.env` to git. The `.gitignore` already excludes it.

---

## 5. Deploy the Smart Contract

### Step 1: Compile the Contract

```bash
npx hardhat compile
```

This compiles `contracts/AcervisRegistry.sol` and generates artifacts in `artifacts/`.

Expected output:
```
Compiled 1 Solidity file successfully
```

### Step 2: Deploy to Polygon Amoy

```bash
npx hardhat run scripts/deploy.cjs --network amoy
```

This uses the PRIVATE_KEY from your `.env` file. The deployer becomes the **Super Admin** of the contract.

Expected output:

```
═══════════════════════════════════════════
   ACERVIS — Polygon Amoy Deployment
═══════════════════════════════════════════

  Deployer:    0x1234...abcd
  Balance:     0.5 POL
  Network:     Polygon Amoy Testnet

🚀 Deploying AcervisRegistry...

✅ Contract deployed!
   Address:    0x5678...ef01
   TX:         0x9012...3456
   Super Admin: 0x1234...abcd
```

### Step 3: Save the Contract Address

Copy the deployed contract address and add it to your `.env`:

```env
CONTRACT_ADDRESS=0x5678...ef01
```

### Step 4: Full Setup (with test institution onboarding)

If you want to also authorize a test institution on-chain automatically:

```bash
npx hardhat run scripts/deploy.cjs --network amoy -- --setup
```

Or set these in your `.env` first:

```env
TEST_INSTITUTION_NAME="Admiralty University"
TEST_INSTITUTION_CODE=ADUN
TEST_INSTITUTION_QUOTA=10000
```

Then run with `--setup`:

```bash
node scripts/deploy.cjs --setup
```

This creates a random institutional wallet and authorizes it on-chain.

---

## 6. Verify the Contract (Polygonscan)

Verifying makes the contract source code public on Polygonscan so anyone can read it.

### Get a Polygonscan API Key

1. Sign up at [polygonscan.com](https://polygonscan.com)
2. Go to your account → **API Keys**
3. Create a new key

### Add to `.env`

```env
POLYGONSCAN_API_KEY=your-api-key-here
```

### Verify

```bash
npx hardhat verify --network amoy CONTRACT_ADDRESS
```

Replace `CONTRACT_ADDRESS` with the deployed address.

After verification, you can see the contract at:
`https://amoy.polygonscan.com/address/CONTRACT_ADDRESS`

---

## 7. Institution Wallet System — Auto-Generated Per Institution

ACERVIS automatically generates a unique Ethereum wallet for **every institution** during onboarding. This replaces the old single `INSTITUTION_PRIVATE_KEY` approach.

### How It Works

1. **Onboarding**: When the Super Admin creates an institution via the API, a new wallet is generated (`ethers.Wallet.createRandom()`)
2. **Encryption**: The private key is encrypted with **AES-256-GCM** using `INSTITUTION_KEY_ENCRYPTION_KEY` from `.env`
3. **Storage**: Only the **wallet address** and **encrypted private key** are stored in the `institutions` DB table
4. **Signing**: During batch issuance, the backend fetches the institution's key, decrypts it, and signs transactions — **each institution signs with its own wallet**

### Authorize Institution Wallets on the Contract

After onboarding, the Super Admin must authorize each institution's wallet on the smart contract.
The wallet address is returned in the onboarding response. Run this for each institution:

```bash
npx hardhat console --network amoy
```

```javascript
const contract = await ethers.getContractAt('AcervisRegistry', '0xYOUR_CONTRACT_ADDRESS');

// Authorize each institution wallet
const tx = await contract.authorizeInstitution(
  '0xINSTITUTION_WALLET_ADDRESS',       // From onboarding response
  'Admiralty University of Nigeria',     // Institution name
  10000                                  // On-chain issuance quota (should match DB)
);
await tx.wait();
console.log('✅ Authorized:', tx.hash);
```

### View Institution Wallets

Use the API to see each institution's wallet:

```bash
curl -H "x-super-admin-secret: YOUR_SECRET" \
  https://your-project.vercel.app/api/v1/institutions
```

Each entry includes `wallet_address`. The private key is never exposed.

---

## 8. Funding Institution Wallets with Gas

Each institution wallet needs POL to pay gas fees for anchoring credential hashes on-chain.

### One-by-One (Manual)

Send POL from your deployer wallet via Hardhat console:

```bash
npx hardhat console --network amoy
```

```javascript
const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const tx = await deployer.sendTransaction({
  to: '0xINSTITUTION_WALLET_ADDRESS',
  value: ethers.parseEther('0.1')  // enough for ~10,000 anchors
});
await tx.wait();
console.log('Sent:', tx.hash);
```

### Bulk Distribution (via API)

Super Admin can send POL to all institution wallets at once using the API.
Only wallets with < 0.005 POL get funded. Default: 0.01 POL per wallet.

```bash
curl -X POST "https://your-project.vercel.app/api/v1/blockchain?action=fund-gas" \
  -H "x-super-admin-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"amount": 0.05}'
```

**Response:**
```json
{
  "success": true,
  "summary": { "funded": 4, "skipped": 2, "total": 6 },
  "results": [
    { "name": "Admiralty Uni", "address": "0x...", "amount": "0.05", "skipped": false },
    { "name": "Uni of Lagos", "address": "0x...", "skipped": true, "reason": "Already has sufficient balance" }
  ]
}
```

**How much POL do you need?**

| Operation | Cost per call | Est. for 10,000 anchors |
|-----------|--------------|------------------------|
| Anchor 1 credential hash | ~0.00005 POL | 0.5 POL |
| 0.01 POL sent to wallet | — | Covers ~200 anchors |

Sending **0.1 POL** per institution wallet is a safe starting point.

### Gas Management Notes

- Each credential hash anchoring costs ~0.00005 POL on Amoy (testnet gas is near-zero)
- Combined CSV (credential + transcript) costs 2 anchors per student → ~0.0001 POL per student
- The deployer wallet (PRIVATE_KEY in .env) pays for gas distribution
- Institutions only pay for their own credential anchoring
- If a wallet runs out, use the `fund-gas` endpoint again

## 9. Test the Connection

### Via the API

After deploying and setting env vars, make a request to the blockchain status endpoint:

```bash
curl -H "x-institution-token: TOKEN" https://your-project.vercel.app/api/v1/blockchain
```

Response shows the institution's own wallet balance:
```json
{
  "configured": true,
  "network": { "connected": true, "chain_id": 80002 },
  "contract": { "deployed": true },
  "wallet": { "address": "0x...", "balance": "0.01" },
  "pending": 0
}
```

### Via Polygonscan

1. Go to `https://amoy.polygonscan.com/address/YOUR_CONTRACT_ADDRESS`
2. Click the **Contract** tab → **Read Contract**
3. Call `superAdmin()` — should show your deployer address
4. Call `institutions(0x...)` with an authorized institution address

---

## 9. Troubleshooting

### "INTERNAL_ERROR: transaction failed"

**Cause:** Out of gas or wallet balance too low.

**Fix:** Get more test POL from the faucet (see [Section 3](#3-get-test-pol-tokens)).

### "insufficient funds for gas"

**Cause:** Wallet doesn't have enough POL.

**Fix:** Send more test POL to the wallet doing the transaction.

### "Nonce too low"

**Cause:** Multiple transactions sent with the same nonce.

**Fix:** Wait a few seconds for pending transactions to confirm, then retry.

### "execution reverted: ACV: Hash already anchored"

**Cause:** You're trying to anchor a credential hash that was already anchored on-chain.

**Fix:** This is normal — each hash can only be anchored once. The API already handles this by catching the error and continuing.

### Contract not appearing on Polygonscan

**Cause:** Verification step was skipped or API key is wrong.

**Fix:** Run `npx hardhat verify --network amoy CONTRACT_ADDRESS` with a valid Polygonscan API key.

### "Invalid institutional token" from API

**Cause:** The institution admin token doesn't match any active institution in the database.

**Fix:** The institution must first be onboarded via the Super Admin console or the `/api/v1/institutions` endpoint. The on-chain authorization is separate from the database authorization.

---

## Architecture Summary

```
┌──────────────────────────────────────────────────┐
│                   Vercel (API)                    │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │
│  │  Issue   │  │  Verify  │  │  Blockchain   │   │
│  │  Endpoint│  │  Endpoint│  │  Endpoint     │   │
│  └────┬─────┘  └────┬─────┘  └──────┬────────┘   │
│       │             │               │            │
│       ▼             ▼               ▼            │
│  ┌──────────────────────────────────────────┐    │
│  │         INSTITUTION_PRIVATE_KEY          │    │
│  │         signs & sends tx to contract     │    │
│  └────────────────┬─────────────────────────┘    │
└───────────────────┼──────────────────────────────┘
                    │
                    │ JSON-RPC (Alchemy)
                    ▼
┌──────────────────────────────────────────────────┐
│              Polygon Amoy (Chain ID: 80002)       │
│  ┌──────────────────────────────────────────┐    │
│  │         AcervisRegistry.sol              │    │
│  │  ┌─────────┐  ┌──────────────┐          │    │
│  │  │registry  │  │ institutions │          │    │
│  │  │mapping   │  │ mapping      │          │    │
│  │  └─────────┘  └──────────────┘          │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### Key Files Reference

| File | Purpose |
|------|---------|
| `contracts/AcervisRegistry.sol` | Smart contract source |
| `hardhat.config.cjs` | Hardhat configuration (network, compiler) |
| `scripts/deploy.cjs` | Deployment script |
| `api/v1/blockchain.js` | API endpoint for status + retry anchoring |
| `api/v1/batch-issue.js` | Batch issuance (anchors hashes on-chain) |
| `api/v1/verify.js` | Verification (queries contract for hash status) |
| `.env.example` | Template with all required env vars |
| `BLOCKCHAIN_SETUP.md` | This guide |

---

## Quick Reference: All Commands

```bash
# 1. Install dependencies
npm install

# 2. Compile contract
npx hardhat compile

# 3. Deploy
npx hardhat run scripts/deploy.cjs --network amoy

# 4. Verify on Polygonscan
npx hardhat verify --network amoy CONTRACT_ADDRESS

# 5. Authorize an institution (via Hardhat console)
npx hardhat console --network amoy
# Then run the authorize command from section 7

# 6. Check blockchain status via API
curl -H "x-institution-token: TOKEN" https://your.vercel.app/api/v1/blockchain
```
