import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

test('shared curatorはURLではなく各toolのproject_idでscopeを選ぶ', () => {
  const skill = readFileSync(resolve(root, 'skills/shared-memory-curator/SKILL.md'), 'utf8');
  expect(skill).toContain('Call `list_projects` without project arguments.');
  expect(skill).toContain('Every other tool call must include the target as a top-level `project_id` argument.');
  expect(skill).toContain('Use `project_id: "__shared__"` for every shared read or write.');
  expect(skill).not.toContain('project_id comes from the MCP URL');
});
