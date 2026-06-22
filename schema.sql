-- ACERVIS PROTOCOL: NEON DB SCHEMA (v3.1.0)
-- Author: Agbontien Praise Ogochukwu
-- Note: Run this in Neon SQL Editor. Use ALTER TABLE statements for existing DB.

-- ============================================================
-- 1. INSTITUTIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS institutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    short_code VARCHAR(10) UNIQUE NOT NULL,
    type VARCHAR(20) CHECK (type IN ('University', 'Polytechnic', 'College')),
    token_id VARCHAR(12) UNIQUE NOT NULL,
    issuance_quota INTEGER DEFAULT 0,
    issued_count INTEGER DEFAULT 0,
    seal_blob_url TEXT,
    admin_email VARCHAR(255) NOT NULL,
    wallet_address VARCHAR(42) UNIQUE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity_at TIMESTAMP WITH TIME ZONE
);

-- ============================================================
-- 2. CREDENTIALS TABLE (certificate-level records)
-- ============================================================
CREATE TABLE IF NOT EXISTS credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID REFERENCES institutions(id) NOT NULL,
    ncn VARCHAR(23) UNIQUE NOT NULL,       -- SHORTCODE-YEAR-8HEX
    student_name VARCHAR(255) NOT NULL,
    matric_number VARCHAR(50) NOT NULL,
    grad_year INTEGER NOT NULL,
    course_name VARCHAR(255) NOT NULL,
    degree_type VARCHAR(50) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    blockchain_hash VARCHAR(66) NOT NULL,
    record_type VARCHAR(20) DEFAULT 'certificate',
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
    tx_hash VARCHAR(66),                   -- On-chain anchor tx hash
    anchored_at TIMESTAMP WITH TIME ZONE,
    issued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- 3. TRANSCRIPTS TABLE (full academic record with subjects)
-- ============================================================
CREATE TABLE IF NOT EXISTS transcripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID REFERENCES institutions(id) NOT NULL,
    ncn VARCHAR(25) UNIQUE NOT NULL,       -- SHORTCODE-T-YEAR-8HEX
    linked_credential_id UUID REFERENCES credentials(id) ON DELETE SET NULL,
    student_name VARCHAR(255) NOT NULL,
    matric_number VARCHAR(50) NOT NULL,
    course_name VARCHAR(255) NOT NULL,
    degree_type VARCHAR(50) NOT NULL,
    graduation_year INTEGER NOT NULL,
    cgpa DECIMAL(4,2),                     -- Cumulative GPA (from CSV)
    total_credits INTEGER DEFAULT 0,
    salt VARCHAR(64) NOT NULL,
    blockchain_hash VARCHAR(66) NOT NULL,
    subjects_hash VARCHAR(66),             -- Hash of all subject data for integrity
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
    tx_hash VARCHAR(66),
    anchored_at TIMESTAMP WITH TIME ZONE,
    issued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- 4. TRANSCRIPT SUBJECTS TABLE (individual course results)
-- ============================================================
CREATE TABLE IF NOT EXISTS transcript_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_id UUID REFERENCES transcripts(id) ON DELETE CASCADE NOT NULL,
    course_code VARCHAR(20) NOT NULL,
    course_title VARCHAR(255) NOT NULL,
    credit_units INTEGER NOT NULL CHECK (credit_units > 0),
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    grade VARCHAR(5) NOT NULL,
    semester VARCHAR(10) NOT NULL CHECK (semester IN ('First', 'Second', 'Summer')),
    session VARCHAR(20) NOT NULL,
    is_compulsory BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- 5. AUDIT LOGS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action VARCHAR(100) NOT NULL,
    actor_id UUID,
    target_id UUID,
    target_type VARCHAR(20),               -- 'credential', 'transcript', 'institution'
    metadata JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- 6. VERIFICATION REQUESTS TABLE (track all lookups)
-- ============================================================
CREATE TABLE IF NOT EXISTS verification_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ncn VARCHAR(25),
    record_type VARCHAR(20) CHECK (record_type IN ('credential', 'transcript')),
    ip_address VARCHAR(45),
    user_agent TEXT,
    result_state VARCHAR(20),
    blockchain_verified BOOLEAN DEFAULT FALSE,
    response_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_credentials_ncn ON credentials(ncn);
CREATE INDEX IF NOT EXISTS idx_credentials_hash ON credentials(blockchain_hash);
CREATE INDEX IF NOT EXISTS idx_credentials_institution ON credentials(institution_id);
CREATE INDEX IF NOT EXISTS idx_credentials_matric ON credentials(institution_id, matric_number);
CREATE INDEX IF NOT EXISTS idx_credentials_status ON credentials(status);
CREATE INDEX IF NOT EXISTS idx_credentials_issued ON credentials(issued_at);

CREATE INDEX IF NOT EXISTS idx_transcripts_ncn ON transcripts(ncn);
CREATE INDEX IF NOT EXISTS idx_transcripts_institution ON transcripts(institution_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_matric ON transcripts(institution_id, matric_number);
CREATE INDEX IF NOT EXISTS idx_transcripts_linked ON transcripts(linked_credential_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_status ON transcripts(status);

CREATE INDEX IF NOT EXISTS idx_transcript_subjects_transcript ON transcript_subjects(transcript_id);
CREATE INDEX IF NOT EXISTS idx_transcript_subjects_course ON transcript_subjects(course_code);
CREATE INDEX IF NOT EXISTS idx_transcript_subjects_session ON transcript_subjects(session);

CREATE INDEX IF NOT EXISTS idx_institutions_token ON institutions(token_id);
CREATE INDEX IF NOT EXISTS idx_institutions_short_code ON institutions(short_code);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_verification_requests_ncn ON verification_requests(ncn);
CREATE INDEX IF NOT EXISTS idx_verification_requests_created ON verification_requests(created_at);
