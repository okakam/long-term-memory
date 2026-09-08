CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- Deletion markers prevent a Blob delete failure from resurrecting a forgotten
-- memory during a later remote reindex. They are metadata, not soft-deleted
-- memories, and are intentionally preserved when rebuildable index tables reset.
CREATE TABLE IF NOT EXISTS memory_tombstones (
  project_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (project_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_memory_tombstones_memory ON memory_tombstones(memory_id);

CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  description  TEXT NOT NULL,
  body_chars   INTEGER NOT NULL DEFAULT 0,
  file_path    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS tags (
  memory_id TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS links (
  src_id   TEXT NOT NULL,
  dst_name TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_name),
  FOREIGN KEY (src_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- Supersession is deliberately NOT stored in links: links are PPR graph edges
-- (ASSOC_WEIGHTS.manualLink = 2.0), so folding supersedes into them would
-- silently change associative recall.
CREATE TABLE IF NOT EXISTS supersedes (
  src_id   TEXT NOT NULL,
  dst_name TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_name),
  FOREIGN KEY (src_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- trigram: substring matching that works for CJK (unicode61 indexed a whole
--   run of kanji/kana as a single token, so Japanese barely matched).
-- contentless_delete=1: lets us DELETE FROM memories_fts WHERE rowid = ?
--   instead of the fragile "reconstruct the old row and INSERT ('delete')" pattern.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  name, description, body, content='', contentless_delete=1, tokenize='trigram'
);

CREATE INDEX IF NOT EXISTS idx_memories_project_type ON memories(project_id, type);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_supersedes_dst ON supersedes(dst_name);

CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id   TEXT NOT NULL,
  alias       TEXT NOT NULL,
  asserted_by TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias, asserted_by),
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (asserted_by) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity_id),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_edges (
  src_entity_id TEXT NOT NULL,
  dst_entity_id TEXT NOT NULL,
  relation      TEXT NOT NULL,
  asserted_by   TEXT NOT NULL,
  PRIMARY KEY (src_entity_id, dst_entity_id, relation, asserted_by),
  FOREIGN KEY (src_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (dst_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (asserted_by)   REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entities_project_name ON entities(project_id, name);
CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_asserted ON entity_aliases(asserted_by);
CREATE INDEX IF NOT EXISTS idx_entity_edges_asserted ON entity_edges(asserted_by);
CREATE INDEX IF NOT EXISTS idx_entity_edges_src ON entity_edges(src_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_edges_dst ON entity_edges(dst_entity_id);
