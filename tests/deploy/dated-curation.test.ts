import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

test('workflow supports paired UTC backfill inputs and defaults manual runs to dry run', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/curator.yml'), 'utf8');
  expect(workflow).toMatch(/dry_run:[\s\S]*?default: true[\s\S]*?type: boolean/);
  expect(workflow).toMatch(/from_date:[\s\S]*?type: string[\s\S]*?to_date:[\s\S]*?type: string/);
  expect(workflow).toContain('FROM_DATE: ${{ inputs.from_date }}');
  expect(workflow).toContain('TO_DATE: ${{ inputs.to_date }}');
  expect(workflow).toContain('pnpm exec tsx scripts/curator/run-dated-curation.ts');
  expect(workflow).toContain("cron: '0 1 * * *'");
});

test('shared curation remains serialized after maintenance failure and receives only its dedicated credentials', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/curator.yml'), 'utf8');
  expect(workflow).toMatch(/remote-curation:[\s\S]*?needs: memory-maintenance[\s\S]*?if: always\(\) && !cancelled\(\)/);
  const remoteJob = workflow.slice(workflow.indexOf('  remote-curation:'));
  expect(remoteJob).toContain('LTM_MCP_TOKEN: ${{ secrets.LTM_MCP_TOKEN }}');
  expect(remoteJob).toContain('LTM_MAINTENANCE_TOKEN: ${{ secrets.LTM_MAINTENANCE_TOKEN }}');
  expect(remoteJob).not.toContain('LTM_AUTO_MAINTENANCE_TOKEN');
  expect(remoteJob).not.toContain('export-remote-snapshot.ts');
  expect(remoteJob).not.toContain('run-curation.sh');
});
