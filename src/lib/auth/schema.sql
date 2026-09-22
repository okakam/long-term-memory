CREATE TABLE IF NOT EXISTS auth_schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'mcp' CHECK (audience = 'mcp'),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL CHECK (token_endpoint_auth_method = 'none'),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_authorization_transactions (
  id TEXT PRIMARY KEY,
  transaction_hash TEXT NOT NULL UNIQUE,
  transaction_prefix TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri TEXT NOT NULL,
  response_type TEXT NOT NULL CHECK (response_type = 'code'),
  scope TEXT NOT NULL CHECK (scope = 'mcp:access'),
  resource TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  csrf_hash TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  client_name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'mcp:access'),
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  grant_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  scope TEXT NOT NULL CHECK (scope = 'mcp:access'),
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  scope TEXT NOT NULL CHECK (scope = 'mcp:access'),
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  scope TEXT NOT NULL CHECK (scope = 'mcp:access'),
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  replaced_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_rate_limits (
  bucket TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (bucket, key_hash, window_start)
);

CREATE INDEX IF NOT EXISTS project_members_user_idx
  ON project_members(user_id, project_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx
  ON mcp_tokens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_grant_idx
  ON oauth_authorization_codes(grant_id, consumed_at, revoked_at);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_grant_idx
  ON oauth_access_tokens(grant_id, revoked_at);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_family_idx
  ON oauth_refresh_tokens(family_id, revoked_at);
CREATE INDEX IF NOT EXISTS oauth_grants_user_idx
  ON oauth_grants(user_id, created_at DESC);
