# ACERVIS — Blockchain Setup Guide

Your database and login are working. This guide gets the **Polygon Amoy** blockchain connected so credential hashes get anchored on-chain.

---

## What You'll Do

```
1. Get a MetaMask wallet + Alchemy RPC URL  (10 min)
2. Get free test POL from a faucet           (2 min)
3. Deploy the smart contract via Remix IDE   (10 min)
4. Add CONTRACT_ADDRESS to Vercel env vars   (3 min)
5. Onboard an institution → wallet generated automatically
6. Authorize that wallet on the contract     (2 min)
7. Fund the wallet with test POL             (2 min)
8. Issue a credential — it anchors on-chain  (done)
```

---

## 1. Get a Deployer Wallet (MetaMask)

This wallet will own the smart contract. You only need **one** — it pays gas to deploy and later funds institution wallets.

**Steps:**

1. Install [MetaMask](https://metamask.io) if you don't have it
2. Create a wallet (or use an existing one)
3. Add **Polygon Amoy Testnet** to MetaMask:

| Field | Value |
|-------|-------|
| Network Name | Polygon Amoy |
| RPC URL | `https://polygon-amoy.g.alchemy.com/v2/YOUR-API-KEY` |
| Chain ID | `80002` |
| Currency Symbol | `POL` |
| Explorer | `https://amoy.polygonscan.com` |

4. Copy your **wallet address** (starts with `0x`)
5. Export your **private key**: MetaMask → three dots → Account details → Export Private Key
6. Save the private key — you'll need it for deployment

> Don't have an Alchemy API key yet? Sign up at [alchemy.com](https://alchemy.com) → Create App → Polygon Amoy. Copy the HTTPS URL.

---

## 2. Get Free Test POL

Your deployer wallet needs test POL to pay gas for deploying the contract.

**Go to one of these faucets and paste your wallet address:**

| Faucet | Link |
|--------|------|
| Alchemy | [faucets.alchemy.com/polygon-amoy](https://faucets.alchemy.com/polygon-amoy) |
| Polygon | [faucet.polygon.technology](https://faucet.polygon.technology) |

Request **0.5 POL**. It's free — testnet tokens have no value. The deployment costs ~0.01 POL so you have plenty.

Wait 30 seconds, then check your MetaMask balance. If it shows POL, you're ready.

---

## 3. Deploy the Smart Contract (via Remix IDE)

Remix runs in your browser — no CLI needed.

**Step-by-step:**

1. Go to [remix.ethereum.org](https://remix.ethereum.org)
2. Create a new file: `AcervisRegistry.sol`
3. Copy-paste the contract from `contracts/AcervisRegistry.sol` in this project
4. Go to the **Solidity Compiler** tab (left sidebar, 3rd icon)
5. Set compiler to `0.8.20`
6. Click **Compile AcervisRegistry.sol** — should show green check
7. Go to **Deploy & Run Transactions** tab (left sidebar, 4th icon)
8. Set **Environment** to **Injected Provider — MetaMask**
9. MetaMask will ask to connect — approve it
10. Make sure the selected account is your **deployer wallet**
11. Click **Deploy**
12. MetaMask opens a confirmation — click **Confirm**
13. Wait ~10 seconds for the transaction to confirm
14. The deployed contract appears under **Deployed Contracts** — **copy the address** (starts with `0x`)

**You now have a deployed contract.** The deployer address is automatically the **Super Admin** of the contract.

---

## 4. Add CONTRACT_ADDRESS to Vercel

You need to add the deployed address to Vercel's environment variables so the API can use it.

**Steps:**

1. Go to [vercel.com](https://vercel.com) → your project
2. Click **Settings** → **Environment Variables**
3. Add the following variables:

| Name | Value |
|------|-------|
| `ALCHEMY_RPC_URL` | Your Alchemy HTTPS URL |
| `CONTRACT_ADDRESS` | The deployed address from step 3 |
| `SUPER_ADMIN_SECRET` | Whatever you set (currently `agbontienpraise26` for local testing) |
| `INSTITUTION_KEY_ENCRYPTION_KEY` | A 64-char hex string (generate below) |
| `DATABASE_URL` | Already set (your Neon connection string) |
| `PROTOCOL_PEPPER` | Already set |

4. Click **Save**
5. Go to **Deployments**, find the latest, click **Redeploy** (three dots → Redeploy)

**Generate INSTITUTION_KEY_ENCRYPTION_KEY:**

Open your browser console (F12) and run:
```javascript
(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Date.now().toString()))).then(h => {
  const hex = Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('');
  console.log(hex);
})
```
Or just use this fixed one for testing: `a6f8c2d1e9b4a73f8c2d1e9b4a73f8c2d1e9b4a73f8c2d1e9b4a73f8c2d1e9b4`

---

## 5. Onboard an Institution (Wallet Auto-Generated)

When you onboard an institution via the Super Admin console, the backend **automatically generates a wallet** for that institution. The private key is encrypted and stored in the database.

**Steps:**

1. Log into the Super Admin console (type `agbontienpraise26` in the terminal on index.html)
2. Go to **Onboard Institution** tab
3. Fill in: name, short code, type, quota, email
4. Click **Authorize Institution**
5. The response shows:
   - **Token ID** — share this with the institution admin
   - **Wallet Address** — you'll authorize this on the contract next

---

## 6. Authorize the Institution Wallet on the Contract

The smart contract only allows authorized wallets to anchor hashes. You need to call `authorizeInstitution()` with the wallet address from step 5.

**Via Remix (same session from step 3):**

1. In Remix, under **Deployed Contracts**, expand your `AcervisRegistry` contract
2. Find the `authorizeInstitution` function
3. Fill in:
   - `_institution` — the wallet address from the onboarding response
   - `_name` — institution name (e.g., "Admiralty University")
   - `_quota` — same as DB quota (e.g., 10000)
4. Click **transact**
5. Confirm in MetaMask
6. Wait for confirmation

**Repeat for each institution you onboard.**

---

## 7. Fund the Institution Wallet with POL

The institution wallet needs test POL to pay gas for anchoring hashes.

**Via Remix (using a manual transaction):**

1. In MetaMask, switch to your **deployer wallet** (the one with POL)
2. Go to **Send** → enter the institution's wallet address
3. Enter amount: `0.1` POL (covers ~2000 anchors)
4. Confirm

**Or via the API** (if PRIVATE_KEY is set in Vercel env):

```js
// From the Super Admin console, you can call:
// POST /api/v1/blockchain?action=fund-gas
// With x-super-admin-secret header
// This distributes 0.01 POL to all institution wallets
```

---

## 8. Verify It Works

**Option A: Via the API**

Log into the admin console with an institution token, then check the blockchain status. The console calls `/api/v1/blockchain` which returns the institution's wallet balance and contract status.

**Option B: Via Polygonscan**

1. Go to `https://amoy.polygonscan.com/address/YOUR_CONTRACT_ADDRESS`
2. Click **Contract** → **Read Contract**
3. Call `superAdmin()` — should show your deployer address
4. Call `institutions(0x...)` with your institution wallet address — should show authorized

**Option C: Issue a credential**

1. Log into the admin console with the institution's token
2. Upload a CSV with one test student
3. Click **Issue & Anchor**
4. If blockchain is configured, the response shows `tx_hashes`
5. Check the transaction on Polygonscan

---

## Quick Reference

| Step | Where | What |
|------|-------|------|
| Get wallet | MetaMask | Create wallet, export private key |
| Get POL | Alchemy faucet | Paste wallet address, get free POL |
| Deploy contract | remix.ethereum.org | Compile + deploy AcervisRegistry.sol |
| Set env vars | vercel.com → Settings → Environment | ALCHEMY_RPC_URL + CONTRACT_ADDRESS |
| Onboard institution | Super Admin console (terminal) | Auto-generates wallet |
| Authorize wallet | Remix → contract → authorizeInstitution() | Links wallet to contract |
| Fund wallet | MetaMask → Send → 0.1 POL | Gives gas for anchoring |
| Issue credential | Admin console → CSV upload | Anchors on-chain |

---

## Env Vars Checklist

```
☐ DATABASE_URL           — already set (login works)
☐ PROTOCOL_PEPPER        — already set
☐ SUPER_ADMIN_SECRET     — already set
☐ ALCHEMY_RPC_URL        — from Alchemy dashboard
☐ CONTRACT_ADDRESS       — from Remix deployment
☐ INSTITUTION_KEY_ENCRYPTION_KEY — generate once, never change
```

---

## Notes

- **Each institution gets its own wallet** — generated during onboarding, key encrypted in DB
- **The deployer wallet funds gas** — send 0.1 POL per institution wallet via MetaMask
- **The contract is already on Amoy testnet** — no mainnet, no real money
- **Test POL is free** — faucets refill daily if you run out
- **Deploy once** — the contract doesn't change, you don't redeploy