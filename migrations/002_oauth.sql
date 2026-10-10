-- 002: OAuth สำหรับ claude.ai connector
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, client_name TEXT, redirect_uris TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
