CREATE TABLE IF NOT EXISTS telemetry_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('tool_call', 'connect')),
  project_id TEXT NOT NULL,
  session_id TEXT,
  tool TEXT,
  kind TEXT CHECK (kind IN ('read', 'write', 'meta') OR kind IS NULL),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error_code TEXT CHECK (error_code IN ('not_found', 'conflict', 'validation', 'internal') OR error_code IS NULL),
  duration_ms INTEGER NOT NULL,
  result_count INTEGER,
  result_chars INTEGER,
  maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1))
);

CREATE INDEX IF NOT EXISTS tool_events_ts_idx ON tool_events(ts);
CREATE INDEX IF NOT EXISTS tool_events_project_idx ON tool_events(project_id, ts);
CREATE INDEX IF NOT EXISTS tool_events_session_idx ON tool_events(session_id);
