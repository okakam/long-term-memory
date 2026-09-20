import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const script = readFileSync(resolve(import.meta.dirname, '../../scripts/start-mcp.sh'), 'utf8');

test('start-mcp はポート占有PIDを調べて同一projectのdev serverだけ再利用する', () => {
  expect(script).toContain('lsof -nP -iTCP:$PORT -sTCP:LISTEN -t');
  expect(script).toContain('ps -p "$PID" -o command=');
  expect(script).toContain('next.*dev');
  expect(script).toContain('exit 1');
  expect(script).toContain('pnpm exec next dev -H "$HOST" -p "$PORT"');
});

test('start-mcp のbackground起動はログを限定パスへ書き、pkillを使わない', () => {
  expect(script).toContain('nohup pnpm exec next dev');
  expect(script).toContain('.ltm-dev.log');
  expect(script).not.toContain('pkill');
});
