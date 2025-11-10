CREATE TABLE users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  phone VARCHAR(32),
  kyc_status VARCHAR(32) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE transfers (
  id VARCHAR(64) PRIMARY KEY,
  external_txn_id VARCHAR(128),
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  business_user_id VARCHAR(64) NOT NULL,
  recipient_email VARCHAR(255) NOT NULL,
  recipient_name VARCHAR(255),
  amount_cents INT NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 2500000),
  currency CHAR(3) DEFAULT 'CAD',
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  use_auto_deposit BOOLEAN DEFAULT true,
  security_question TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transfers_user ON transfers(business_user_id);
CREATE INDEX idx_transfers_external ON transfers(external_txn_id);

CREATE TABLE transfer_events (
  id SERIAL PRIMARY KEY,
  transfer_id VARCHAR(64) NOT NULL REFERENCES transfers(id),
  event_type VARCHAR(64) NOT NULL,
  event_payload JSONB,
  received_at TIMESTAMP DEFAULT NOW()
);
