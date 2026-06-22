// ACERVIS: Cryptographic Helpers — NCN Synthesis Engine
import { createHmac, randomBytes } from 'crypto';

// The NCN Synthesis: D = HMAC-SHA256(ρ, P + σ)
export function synthesizeHash(payload, salt) {
  const pepper = process.env.PROTOCOL_PEPPER;
  if (!pepper) throw new Error('PROTOCOL_PEPPER not configured');
  return createHmac('sha256', pepper).update(payload + salt).digest('hex');
}

// Build the canonical payload string: name|year|course|degree|matric
export function buildPayload(name, year, course, degree, matric) {
  return `${name}|${year}|${course}|${degree}|${matric}`.toLowerCase();
}

// Generate a random salt (16 bytes → 32 hex chars)
export function generateSalt() {
  return randomBytes(16).toString('hex');
}

// Generate a unique NCN: SHORTCODE-YEAR-8HEX
export function generateNcn(shortCode, year, prefix = '') {
  return `${shortCode}${prefix}-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

// Generate a unique NCN for credentials
export function generateCredentialNcn(shortCode, year) {
  return generateNcn(shortCode, year);
}

// Generate a unique NCN for transcripts (with T- prefix)
export function generateTranscriptNcn(shortCode, year) {
  return generateNcn(shortCode, year, '-T');
}

// Recompute hash to verify integrity
export function verifyIntegrity(record, pepper) {
  const payload = buildPayload(
    record.student_name,
    record.grad_year || record.graduation_year,
    record.course_name,
    record.degree_type,
    record.matric_number
  );
  const localHash = synthesizeHash(payload, record.salt);
  return localHash === record.blockchain_hash;
}
