import { pathToFileURL } from 'node:url';

const EXPECTED_TOOLS = [
  'list_memories_by_type', 'search_by_tag', 'find_related', 'search_memories', 'get_memory', 'get_memory_index',
  'remember_user_fact', 'remember_reference', 'remember_session_summary', 'remember_feedback', 'remember_project_fact',
  'update_memory', 'forget_memory', 'link_memories', 'list_projects', 'reindex',
];

interface JsonRpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }>; tools?: Array<{ name?: string }> };
  error?: { code?: number };
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function call(baseUrl: string, projectId: string, token: string, message: object): Promise<JsonRpcResponse> {
  const response = await fetch(`${baseUrl}/api/mcp?project_id=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const payload = await response.json() as JsonRpcResponse;
  if (payload.error) throw new Error(`MCP JSON-RPC error ${payload.error.code ?? 'unknown'}`);
  return payload;
}

function resultText(response: JsonRpcResponse): string {
  const text = response.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP result text missing');
  return text;
}

export function assertTools(response: JsonRpcResponse): void {
  const names = (response.result?.tools ?? []).map((tool) => tool.name);
  if (names.length !== EXPECTED_TOOLS.length || EXPECTED_TOOLS.some((name) => !names.includes(name))) {
    throw new Error('unexpected MCP tool catalog');
  }
}

async function callTool(baseUrl: string, projectId: string, token: string, id: number, name: string, arguments_: object): Promise<string> {
  return resultText(await call(baseUrl, projectId, token, {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
  }));
}

export async function smoke(): Promise<void> {
  const baseUrl = required('CLOUD_RUN_URL').replace(/\/+$/, '');
  const token = required('LTM_MCP_TOKEN');
  const projectId = process.env.LTM_SMOKE_PROJECT_ID ?? 'smoke';
  const health = await fetch(`${baseUrl}/api/health`);
  if (!health.ok) throw new Error(`health HTTP ${health.status}`);
  await call(baseUrl, projectId, token, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cloud-run-smoke', version: '1' } },
  });
  assertTools(await call(baseUrl, projectId, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  const name = `cloud-run-smoke-${Date.now().toString(36)}`;
  const targetName = `${name}-target`;
  let saved = false;
  let targetSaved = false;
  try {
    await callTool(baseUrl, projectId, token, 3, 'remember_reference', {
      name, description: 'Cloud Run smoke', body: '日本語検索の確認',
    });
    saved = true;
    const fetched = JSON.parse(await callTool(baseUrl, projectId, token, 4, 'get_memory', { id_or_name: name })) as { name?: string };
    if (fetched.name !== name) throw new Error('smoke get_memory mismatch');
    await callTool(baseUrl, projectId, token, 5, 'update_memory', {
      id_or_name: name,
      patch: { body: '日本語検索の更新確認', tags: ['cloud-run-smoke'] },
    });
    await callTool(baseUrl, projectId, token, 6, 'remember_reference', {
      name: targetName, description: 'Cloud Run smoke target', body: 'リンク先確認',
    });
    targetSaved = true;
    await callTool(baseUrl, projectId, token, 7, 'link_memories', { src: name, dst: targetName });
    const linked = JSON.parse(await callTool(baseUrl, projectId, token, 8, 'get_memory', { id_or_name: name })) as { links?: string[] };
    if (!linked.links?.includes(targetName)) throw new Error('smoke link mismatch');
    await callTool(baseUrl, projectId, token, 9, 'reindex', {});
    const search = JSON.parse(await callTool(baseUrl, projectId, token, 10, 'search_memories', { query: '更新確認' })) as Array<{ name?: string }>;
    if (!search.some((item) => item.name === name)) throw new Error('smoke memory not found');
  } finally {
    if (targetSaved) await callTool(baseUrl, projectId, token, 11, 'forget_memory', { id_or_name: targetName });
    if (saved) await callTool(baseUrl, projectId, token, 12, 'forget_memory', { id_or_name: name });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  smoke().then(() => console.log('Cloud Run smoke: PASS')).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Cloud Run smoke: FAIL');
    process.exitCode = 1;
  });
}
