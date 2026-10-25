import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Runs the wrapper against a stub pnpm that records which credentials each step receives.
function runWrapper(failingScript?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-wrapper-'));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(repo, 'node_modules/.bin/tsx'), '#!/bin/sh\n');
  chmodSync(join(repo, 'node_modules/.bin/tsx'), 0o755);
  const calls = join(dir, 'calls.log');
  writeFileSync(join(bin, 'pnpm'), `#!/bin/bash
script="$3"
echo "$script auto=\${LTM_AUTO_MAINTENANCE_TOKEN:+set} pat=\${LTM_MCP_TOKEN:+set} shared=\${LTM_MAINTENANCE_TOKEN:+set}" >> "${calls}"
[[ "$script" == "${failingScript ?? 'none'}" ]] && exit 3
exit 0
`);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const envFile = join(dir, 'env');
  writeFileSync(envFile, [
    'LTM_MODE=remote', 'DRY_RUN=1', 'MCP_PUBLIC_URL=https://ltm.example', 'CLAUDE_BIN=claude',
    'LTM_MCP_TOKEN=pat', 'LTM_MAINTENANCE_TOKEN=shared', 'LTM_AUTO_MAINTENANCE_TOKEN=auto',
  ].join('\n'));
  const result = spawnSync('bash', [resolve(root, 'scripts/curator/run-curation.sh')], {
    env: {
      NODE_ENV: 'test',
      HOME: dir,
      PATH: `${bin}:/usr/bin:/bin`,
      LTM_CURATOR_REPO_ROOT: repo,
      LTM_CURATOR_ENV: envFile,
      LTM_CURATOR_PATH: `${bin}:/usr/bin:/bin`,
      LTM_CURATOR_LOG_DIR: join(dir, 'log'),
    },
    encoding: 'utf8',
  });
  return { status: result.status, calls: readFileSync(calls, 'utf8').trim().split('\n') };
}

test('wrapperは通常棚卸しと共有集約に別々のcredentialだけを渡す', () => {
  const { status, calls } = runWrapper();
  expect(status).toBe(0);
  expect(calls).toEqual([
    'scripts/curator/run-maintenance.ts auto=set pat= shared=',
    'scripts/curator/run-dated-curation.ts auto= pat=set shared=set',
  ]);
});

test('通常棚卸しが失敗しても共有集約を実行し、全体は失敗で終える', () => {
  const { status, calls } = runWrapper('scripts/curator/run-maintenance.ts');
  expect(status).toBe(1);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain('scripts/curator/run-dated-curation.ts');
});

test('実行中のlockがあれば二重実行せずに失敗する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-wrapper-lock-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'log/run.lock'), { recursive: true });
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/.bin/tsx'), '#!/bin/sh\n');
  chmodSync(join(repo, 'node_modules/.bin/tsx'), 0o755);
  writeFileSync(join(dir, 'env'), 'LTM_MODE=local\nDRY_RUN=1\n');
  const result = spawnSync('bash', [resolve(root, 'scripts/curator/run-curation.sh')], {
    env: {
      NODE_ENV: 'test', HOME: dir, PATH: '/usr/bin:/bin',
      LTM_CURATOR_REPO_ROOT: repo, LTM_CURATOR_ENV: join(dir, 'env'), LTM_CURATOR_LOG_DIR: join(dir, 'log'),
    },
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('another curator run is in progress');
});
