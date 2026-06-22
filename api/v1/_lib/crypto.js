// ACERVIS: Cryptographic Helpers — NCN Synthesis + Wallet Encryption
import { createHmac, createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';

// ─── NCN Synthesis ─────────────────────────────────────────

export function synthesizeHash(payload, salt) {
  const pepper = process.env.PROTOCOL_PEPPER;
  if (!pepper) throw new Error('PROTOCOL_PEPPER not configured');
  return createHmac('sha256', pepper).update(payload + salt).digest('hex');
}

export function buildPayload(name, year, course, degree, matric) {
  return `${name}|${year}|${course}|${degree}|${matric}`.toLowerCase();
}

export function generateSalt() {
  return randomBytes(16).toString('hex');
}

export function generateNcn(shortCode, year, prefix = '') {
  return `${shortCode}${prefix}-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function generateCredentialNcn(shortCode, year) {
  return generateNcn(shortCode, year);
}

export function generateTranscriptNcn(shortCode, year) {
  return generateNcn(shortCode, year, '-T');
}

export function verifyIntegrity(record, pepper) {
  const payload = buildPayload(
    record.student_name, record.grad_year || record.graduation_year,
    record.course_name, record.degree_type, record.matric_number
  );
  return synthesizeHash(payload, record.salt) === record.blockchain_hash;
}

// ─── Institution Wallet Encryption ─────────────────────────

// Derive a 32-byte AES key from the INSTITUTION_KEY_ENCRYPTION_KEY env var
function getEncryptionKey() {
  const raw = process.env.INSTITUTION_KEY_ENCRYPTION_KEY;
  if (!raw) throw new Error('INSTITUTION_KEY_ENCRYPTION_KEY not configured');
  return createHash('sha256').update(raw).digest(); // exactly 32 bytes
}

// Encrypt a private key for DB storage
// Returns: "iv:authTag:ciphertext" (all hex)
export function encryptPrivateKey(privateKey) {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

// Decrypt a private key from DB storage
// Input: "iv:authTag:ciphertext" (all hex)
export function decryptPrivateKey(stored) {
  const key = getEncryptionKey();
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted key format');
  const [ivHex, authTagHex, ciphertext] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Generate a new Ethereum wallet, returns { address, privateKey, encryptedKey }
export async function generateInstitutionWallet() {
  const { ethers } = await import('ethers');
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    encryptedKey: encryptPrivateKey(wallet.privateKey)
  };
}

// Create an ethers Wallet from an institution's encrypted private key
export async function walletFromInstitution(provider, encryptedKey) {
  const { ethers } = await import('ethers');
  const privateKey = decryptPrivateKey(encryptedKey);
  return new ethers.Wallet(privateKey, provider);
}
