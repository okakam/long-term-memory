import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const manifestPath = 'src/lib/mcp/setup-manifest.generated.ts';
const assetPaths = [
  'skills/long-term-memory/SKILL.md',
  'claude-config/hooks/ltm-init-reminder.sh',
  'claude-config/claude-md-block.md',
];
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

type Manifest = {
  schema_version: number;
  config_version: string;
  guide_markdown: string;
  assets: Array<{ path: string; sha256: string; content: string }>;
};

function readManifest(): Manifest {
  expect(existsSync(resolve(root, manifestPath)), 'generated setup manifest must exist').toBe(true);
  const literal = read(manifestPath).match(/export const SETUP_MANIFEST = ([\s\S]+) as const;\s*$/);
  expect(literal, 'manifest must contain a JSON literal').not.toBeNull();
  return JSON.parse(literal![1]) as Manifest;
}

test('配布manifestは正本3資産のUTF-8内容とSHA-256を保持する', () => {
  const manifest = readManifest();
  expect(manifest.schema_version).toBe(1);
  expect(manifest.assets.map((asset) => asset.path)).toEqual(assetPaths);
  for (const asset of manifest.assets) {
    const source = read(asset.path);
    expect(asset.content).toBe(source);
    expect(asset.sha256).toBe(sha256(source));
  }
});

test('配布ガイドには正本資産のrender済みembedが含まれる', () => {
  const manifest = readManifest();
  expect(manifest.guide_markdown).toBe(read('docs/post-mcp-setup.md'));
  const embeds = [...manifest.guide_markdown.matchAll(/<!-- ltm:embed src="([^"]+)"[^\n]+ -->\n(`{3,})[^\n]+\n([\s\S]*?)\n\2\n<!-- \/ltm:embed -->/g)];
  expect(embeds.map((embed) => embed[1])).toEqual(assetPaths);
  for (const embed of embeds) {
    expect(embed[3]).toBe(read(embed[1]).replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  }
});

test('config versionはガイドと順序付き資産path/hashのJSONから決定する', () => {
  const manifest = readManifest();
  const versionInput = JSON.stringify({
    guide_markdown: read('docs/post-mcp-setup.md'),
    assets: assetPaths.map((path) => ({ path, sha256: sha256(read(path)) })),
  });
  expect(manifest.config_version).toBe(`sha256:${sha256(versionInput)}`);
});

test('syncは不足・古いmanifestと古いembedを検出し、更新後は冪等になる', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'ltm-setup-manifest-'));
  const script = resolve(fixture, 'scripts/sync-embedded-docs.mjs');
  const generated = resolve(fixture, manifestPath);
  try {
    for (const path of ['scripts/sync-embedded-docs.mjs', 'docs/post-mcp-setup.md', ...assetPaths]) {
      mkdirSync(dirname(resolve(fixture, path)), { recursive: true });
      cpSync(resolve(root, path), resolve(fixture, path), { recursive: true });
    }
    mkdirSync(dirname(generated), { recursive: true });
    const check = () => spawnSync('node', [script, '--check'], { encoding: 'utf8' }).status;
    const sync = () => execFileSync('node', [script], { encoding: 'utf8' });
    expect(check()).toBe(1);
    sync();
    expect(check()).toBe(0);
    const original = readFileSync(generated, 'utf8');
    sync();
    expect(readFileSync(generated, 'utf8')).toBe(original);
    writeFileSync(generated, original + '// stale\n');
    expect(check()).toBe(1);
    expect(readFileSync(generated, 'utf8')).toBe(original + '// stale\n');
    sync();
    expect(readFileSync(generated, 'utf8')).toBe(original);

    const asset = resolve(fixture, assetPaths[0]);
    writeFileSync(asset, readFileSync(asset, 'utf8') + '\n日本語と`backticks`の更新\n');
    expect(check()).toBe(1);
    sync();
    expect(check()).toBe(0);
    const updated = readFileSync(generated, 'utf8');
    expect(updated).not.toBe(original);
    const guide = resolve(fixture, 'docs/post-mcp-setup.md');
    const rendered = readFileSync(guide, 'utf8');
    expect(rendered).toContain('日本語と`backticks`の更新');
    sync();
    expect(readFileSync(generated, 'utf8')).toBe(updated);
    expect(readFileSync(guide, 'utf8')).toBe(rendered);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
