-- ACERVIS PROTOCOL: NEON DB SCHEMA (v3.0.0)
-- Author: Agbontien Praise Ogochukwu

-- 1. INSTITUTIONS TABLE
CREATE TABLE institutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    short_code VARCHAR(10) UNIQUE NOT NULL,
    type VARCHAR(20) CHECK (type IN ('University', 'Polytechnic')),
    token_id VARCHAR(12) UNIQUE NOT NULL, -- The institutional login token
    issuance_quota INTEGER DEFAULT 0,
    issued_count INTEGER DEFAULT 0,
    seal_blob_url TEXT,
    admin_email VARCHAR(255) NOT NULL,
    wallet_address VARCHAR(42) UNIQUE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. CREDENTIALS TABLE
CREATE TABLE credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID REFERENCES institutions(id),
    ncn VARCHAR(20) UNIQUE NOT NULL,       -- National Credential Number
    student_name VARCHAR(255) NOT NULL,
    matric_number VARCHAR(50) NOT NULL,
    grad_year INTEGER NOT NULL,
    course_name VARCHAR(255) NOT NULL,
    degree_type VARCHAR(50) NOT NULL,
    salt VARCHAR(64) NOT NULL,             -- Row-level entropy
    blockchain_hash VARCHAR(66) NOT NULL,  -- The anchored D-value
    status VARCHAR(20) DEFAULT 'active',   -- active, suspended, revoked
    issued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. AUDIT LOGS TABLE
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action VARCHAR(100) NOT NULL,
    actor_id UUID, -- UUID of the institution or 'system'
    target_id UUID, -- UUID of the credential
    metadata JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- INDEXES FOR PERFORMANCE
CREATE INDEX idx_credentials_ncn ON credentials(ncn);
CREATE INDEX idx_credentials_hash ON credentials(blockchain_hash);
CREATE INDEX idx_institutions_token ON institutions(token_id);
