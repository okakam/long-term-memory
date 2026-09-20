#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const documents = ['docs/post-mcp-setup.md'];
const markerPattern = /^<!-- ltm:embed src="([^"]+)" fence="([0-9]+)" lang="([^"]+)" -->$/gm;
const endMarker = '<!-- /ltm:embed -->';
const fenceCharacter = String.fromCharCode(96);
const checkOnly = process.argv.includes('--check');

function renderDocument(documentPath) {
  const absolute = resolve(root, documentPath);
  const original = readFileSync(absolute, 'utf8');
  let found = 0;
  let cursor = 0;
  let output = '';
  let match;
  markerPattern.lastIndex = 0;
  while ((match = markerPattern.exec(original)) !== null) {
    found += 1;
    output += original.slice(cursor, match.index);
    const source = resolve(root, match[1]);
    const content = readFileSync(source, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const requestedFence = Number(match[2]);
    const longestRun = Math.max(...(content.match(new RegExp(fenceCharacter + '+', 'g')) ?? ['']).map((item) => item.length));
    const fenceLength = Math.max(requestedFence, longestRun + 1, 3);
    const fence = fenceCharacter.repeat(fenceLength);
    const endIndex = original.indexOf(endMarker, markerPattern.lastIndex);
    if (endIndex < 0) throw new Error('missing embed end marker in ' + documentPath);
    output += match[0] + '\n' + fence + match[3] + '\n' + content + '\n' + fence + '\n' + endMarker;
    cursor = endIndex + endMarker.length;
    markerPattern.lastIndex = cursor;
  }
  output += original.slice(cursor);
  if (found === 0) throw new Error('no embed sentinel in ' + documentPath);
  return { absolute, original, output };
}

let changed = false;
for (const document of documents) {
  const result = renderDocument(document);
  if (result.original !== result.output) {
    changed = true;
    if (!checkOnly) writeFileSync(result.absolute, result.output);
  }
}
if (checkOnly && changed) {
  console.error('embedded docs are out of date');
  process.exitCode = 1;
} else if (!checkOnly) {
  console.log('embedded docs synchronized');
}
