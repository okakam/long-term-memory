import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
test('native SQLite loads and supports the required FTS options', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, content='', contentless_delete=1, tokenize='trigram')");
    db.prepare('INSERT INTO probe(rowid, body) VALUES (?, ?)').run(1, '長期記憶');
    expect(db.prepare('SELECT rowid FROM probe WHERE probe MATCH ?').all('長期記')).toEqual([{ rowid: 1 }]);
    db.prepare('DELETE FROM probe WHERE rowid = ?').run(1);
    expect(db.prepare('SELECT rowid FROM probe').all()).toEqual([]);
  } finally { db.close(); }
});
