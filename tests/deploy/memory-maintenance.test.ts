import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { assertMaintenanceTools } from '../../scripts/cloud-run-smoke';

const root = resolve(import.meta.dirname, '../..');

test('workflow_serializes_jobs', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/curator.yml'), 'utf8');
  expect(workflow).toContain('group: ltm-curator');
  expect(workflow).toMatch(/memory-maintenance:[\s\S]*?LTM_AUTO_MAINTENANCE_TOKEN:/);
  expect(workflow).toMatch(/remote-curation:[\s\S]*?needs: memory-maintenance/);
  expect(workflow).toContain("if: always() && !cancelled()");
  expect(workflow).toContain("cron: '0 1 * * *'");
  expect(workflow).toContain('default: true');
});

test('Cloud Runデプロイはauto maintenance tokenをSecret Managerから参照する', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/cloud-run.yml'), 'utf8');
  expect(workflow).toContain('LTM_AUTO_MAINTENANCE_TOKEN=');
  expect(workflow).toContain('GCP_SECRET_LTM_AUTO_MAINTENANCE_TOKEN');
});

test('Cloud Run smokeは専用maintenance registryが通常17 toolsから隔離されることを確認する', () => {
  const names = ['maintenance_list_projects', 'maintenance_snapshot', 'maintenance_apply'];
  expect(() => assertMaintenanceTools({ result: { tools: names.map((name) => ({ name })) } })).not.toThrow();
  expect(() => assertMaintenanceTools({ result: { tools: [{ name: 'forget_memory' }] } })).toThrow('unexpected maintenance MCP tool catalog');
  const smoke = readFileSync(resolve(root, 'scripts/cloud-run-smoke.ts'), 'utf8');
  expect(smoke).toContain("'x-ltm-operation-mode': 'maintenance'");
  expect(smoke).toContain("required('LTM_AUTO_MAINTENANCE_TOKEN')");
});
