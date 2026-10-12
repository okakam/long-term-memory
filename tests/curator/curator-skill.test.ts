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

test('shared curatorは記憶をforgetせず、sessionから耐久情報だけ昇格する', () => {
  const skill = readFileSync(resolve(root, 'skills/shared-memory-curator/SKILL.md'), 'utf8');
  expect(skill).not.toContain('forget_memory');
  expect(skill).toContain('never permanently delete an existing shared memory');
  expect(skill).toContain('Include session memories');
  expect(skill).toContain('daily difference');
  expect(skill).toContain('UTC');
});

test('dated runnerはproposal onlyで、shared restoreは専用requestから処理する', () => {
  const skill = readFileSync(resolve(root, 'skills/shared-memory-curator/SKILL.md'), 'utf8');
  expect(skill).toContain('empty MCP configuration');
  expect(skill).toContain('Return a JSON array of proposals');
  expect(skill).toContain('never request `curation_apply` or `curation_checkpoint`');
  expect(skill).toContain('Only the configured curator UID may create it in the Dashboard.');
  expect(skill).toContain('Do not call the ordinary project restore endpoint');
});

test('remote shell entrypoint delegates to the validated dated runner', () => {
  const wrapper = readFileSync(resolve(root, 'scripts/curator/run-curation.sh'), 'utf8');
  expect(wrapper).toContain('pnpm exec tsx scripts/curator/run-dated-curation.ts');
  expect(wrapper).toContain('GITHUB_EVENT_NAME="${GITHUB_EVENT_NAME:-schedule}"');
  expect(wrapper).not.toContain('LTM_SNAPSHOT');
});
