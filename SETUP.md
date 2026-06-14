# ACERVIS QUICKSTART ⚡

The non-complex, "gucci" guide to getting ACERVIS live.

---

## 1. Data & Infrastructure
1.  **Neon.tech:** Create a project. Go to the SQL Editor and paste the content of `schema.sql`. Run it.
2.  **Vercel Blob:** In your Vercel Dashboard, go to **Storage** -> **Connect Database** -> **Create New** -> **Blob**.

## 2. Vercel Environment Variables
Add these 5 keys to your Vercel Project Settings:
- `DATABASE_URL`: (From Neon Connection string)
- `PROTOCOL_PEPPER`: (Any random 32-character string)
- `SUPER_ADMIN_SECRET`: (Your personal password for admin actions)
- `ALCHEMY_RPC_URL`: (Optional: Only if using live blockchain)
- `CONTRACT_ADDRESS`: (Optional: Only if using live blockchain)

## 3. Deployment
```bash
git add .
git commit -m "Genesis ACERVIS Protocol"
git push origin main
```
Vercel will auto-deploy the site and the `/api` functions.

## 4. First Login
- Open your live site.
- Scroll to the footer terminal.
- Type: `login [YOUR_TOKEN]` (Once you've created an institution via the onboard API).

---
*That's it. You're gucci.*
