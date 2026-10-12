import { describe, expect, test } from 'vitest';

import { parseMemoryString, serializeMemory } from '@/lib/markdown/frontmatter';
import { bodyChars, MemorySchema, type Memory } from '@/lib/memory/types';

const memory = (overrides: Partial<Memory> = {}): Memory => ({
  id: '01KS203H51Z8822PWSKZ2QBBQ8',
  name: 'storage-architecture',
  description: 'markdown正 + SQLite索引 のハイブリッド構成',
  type: 'project',
  tags: ['architecture', 'storage'],
  links: [],
  entities: [],
  triples: [],
  supersedes: [],
  body: '本文（markdown）…',
  created_at: '2026-05-20T06:10:27.105Z',
  updated_at: '2026-06-02T07:51:42.244Z',
  ...overrides,
});

describe('serializeMemory', () => {
  test('固定順で必須キーを書き、空の任意配列を省略して本文を改行で終える', () => {
    expect(serializeMemory(memory())).toBe(`---
id: 01KS203H51Z8822PWSKZ2QBBQ8
name: storage-architecture
description: markdown正 + SQLite索引 のハイブリッド構成
type: project
tags:
  - architecture
  - storage
links: []
created_at: '2026-05-20T06:10:27.105Z'
updated_at: '2026-06-02T07:51:42.244Z'
---
本文（markdown）…
`);
  });

  test('entities、triples、source_refs を正規形でシリアライズする', () => {
    const output = serializeMemory(memory({
      entities: [{ name: 'Markdown', aliases: [] }, { name: 'SQLite', aliases: ['index.db'] }],
      triples: [['SQLite', 'indexes', 'Markdown']],
      source_refs: [{ project_id: 'other-project', memory: 'source-memory' }],
    }));

    expect(output).toContain(`entities:
  - name: Markdown
  - name: SQLite
    aliases:
      - index.db
triples:
  - - SQLite
    - indexes
    - Markdown
source_refs:
  - project_id: other-project
    memory: source-memory
---`);
  });

  test('出典・見直し日時・archive状態をfrontmatterへ保存する', () => {
    const output = serializeMemory(memory({
      sources: [{ kind: 'url', url: 'https://example.test/doc', captured_at: '2026-10-01T00:00:00.000Z' }],
      last_reviewed_at: '2026-10-01T00:00:00.000Z',
      next_review_at: '2027-03-30T00:00:00.000Z',
      status: 'archived',
      archived_at: '2026-10-02T00:00:00.000Z',
      archive_reason: 'completed',
      archived_by: 'maintenance',
    }));

    expect(parseMemoryString(output)).toMatchObject({
      sources: [{ kind: 'url', url: 'https://example.test/doc', captured_at: '2026-10-01T00:00:00.000Z' }],
      last_reviewed_at: '2026-10-01T00:00:00.000Z',
      next_review_at: '2027-03-30T00:00:00.000Z',
      status: 'archived',
      archived_at: '2026-10-02T00:00:00.000Z',
      archive_reason: 'completed',
      archived_by: 'maintenance',
    });
  });

  test.each(['y', 'n', 'yes', 'no', 'on', 'off'])('YAML boolean alias %s を文字列として往復する', (alias) => {
    const parsed = parseMemoryString(serializeMemory(memory({ tags: [alias] })));
    expect(parsed.tags).toEqual([alias]);
  });
});

describe('parseMemoryString', () => {
  test('YAML timestamp の Date を ISO 文字列へ戻し本文境界の改行を除去する', () => {
    const parsed = parseMemoryString(`---
id: 01KS203H51Z8822PWSKZ2QBBQ8
name: storage-architecture
description: description
type: project
tags: []
links: []
created_at: 2026-05-20T06:10:27.105Z
updated_at: 2026-06-02T07:51:42.244Z
---


body


`);

    expect(parsed.created_at).toBe('2026-05-20T06:10:27.105Z');
    expect(parsed.updated_at).toBe('2026-06-02T07:51:42.244Z');
    expect(parsed.body).toBe('body');
  });

  test('形または要素型が不正な triple を捨てる', () => {
    const parsed = parseMemoryString(`---
id: id
name: valid-name
description: description
type: reference
tags: []
links: []
created_at: '2026-05-20T06:10:27.105Z'
updated_at: '2026-06-02T07:51:42.244Z'
triples:
  - [subject, predicate, object]
  - [too, short]
  - [subject, predicate, 1]
  - invalid
---
body
`);

    expect(parsed.triples).toEqual([['subject', 'predicate', 'object']]);
  });

  test('aliases と source_refs の不正要素を除去する', () => {
    const parsed = parseMemoryString(`---
id: id
name: valid-name
description: description
type: reference
tags: []
links: []
created_at: '2026-05-20T06:10:27.105Z'
updated_at: '2026-06-02T07:51:42.244Z'
entities:
  - name: Entity
    aliases: [valid, '', 1]
source_refs:
  - { project_id: project, memory: source }
  - { project_id: project }
  - { project_id: 1, memory: source }
---
body
`);

    expect(parsed.entities).toEqual([{ name: 'Entity', aliases: ['valid'] }]);
    expect(parsed.source_refs).toEqual([{ project_id: 'project', memory: 'source' }]);
  });

  test('候補を最後に MemorySchema で検証して不正な必須値を拒否する', () => {
    expect(() => parseMemoryString(`---
id: id
name: valid-name
description: ''
type: reference
tags: []
links: []
created_at: '2026-05-20T06:10:27.105Z'
updated_at: '2026-06-02T07:51:42.244Z'
---
body
`)).toThrow();
    expect(() => MemorySchema.parse(memory({ description: '' }))).toThrow();
  });

  test('legacy URL 行はHTTPS出典へ導出し、legacy status はactiveとして扱う', () => {
    const parsed = parseMemoryString(`---
id: legacy-id
name: legacy-reference
description: legacy
type: reference
tags: []
links: []
created_at: '2026-05-20T06:10:27.105Z'
updated_at: '2026-06-02T07:51:42.244Z'
source_refs:
  - project_id: source-project
    memory: source-memory
---
reference text

URL: https://example.test/legacy?view=1
`);

    expect(parsed.status).toBe('active');
    expect(parsed.sources).toEqual([{
      kind: 'url', url: 'https://example.test/legacy?view=1', captured_at: '2026-05-20T06:10:27.105Z',
    }]);
    expect(parsed.source_refs).toEqual([{ project_id: 'source-project', memory: 'source-memory' }]);
  });
});

test('bodyChars は UTF-16 ではなく Unicode code point を数える', () => {
  expect(bodyChars('A𠮷👍')).toBe(3);
});
