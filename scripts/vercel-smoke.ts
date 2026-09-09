import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_TOOLS = [
  'list_memories_by_type',
  'search_by_tag',
  'find_related',
  'search_memories',
  'get_memory',
  'get_memory_index',
  'remember_user_fact',
  'remember_reference',
  'remember_session_summary',
  'remember_feedback',
  'remember_project_fact',
  'update_memory',
  'forget_memory',
  'link_memories',
  'list_projects',
  'reindex',
];

interface JsonRpcResult {
  result?: { content?: Array<{ type?: string; text?: string }>; tools?: Array<{ name?: string }> };
  error?: { code?: number };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('missing ' + name);
  return value;
}

function protectionHeaders(bypassSecret?: string): Record<string, string> {
  return bypassSecret ? { 'x-vercel-protection-bypass': bypassSecret } : {};
}

function requestHeaders(token: string, bypassSecret?: string): Record<string, string> {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...protectionHeaders(bypassSecret) };
}

async function call(baseUrl: string, projectId: string, token: string, message: object): Promise<JsonRpcResult> {
  const response = await fetch(
    baseUrl + '/api/mcp?project_id=' + encodeURIComponent(projectId),
    {
      method: 'POST',
      headers: requestHeaders(token, process.env.VERCEL_AUTOMATION_BYPASS_SECRET),
      body: JSON.stringify(message),
    },
  );
  if (!response.ok) throw new Error('MCP HTTP ' + response.status);
  const payload = await response.json() as JsonRpcResult;
  if (payload.error) throw new Error('MCP JSON-RPC error ' + payload.error.code);
  return payload;
}

function resultText(response: JsonRpcResult): string {
  const text = response.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP result text missing');
  return text;
}

function assertTools(response: JsonRpcResult): void {
  const tools = response.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  if (tools.length !== EXPECTED_TOOLS.length || EXPECTED_TOOLS.some((name) => !names.includes(name))) {
    throw new Error('unexpected MCP tool catalog');
  }
}

async function smoke(): Promise<void> {
  const baseUrl = (process.env.VERCEL_SMOKE_URL ?? process.env.MCP_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const token = required('LTM_MCP_TOKEN');
  const projectId = process.env.LTM_SMOKE_PROJECT_ID ?? 'smoke';
  if (!baseUrl) throw new Error('missing VERCEL_SMOKE_URL');

  await call(baseUrl, projectId, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'vercel-smoke', version: '1' },
    },
  });
  assertTools(await call(baseUrl, projectId, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }));

  const name = 'vercel-smoke-' + Date.now().toString(36);
  let saved = false;
  try {
    const savedResponse = await call(baseUrl, projectId, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'remember_project_fact',
        arguments: {
          name,
          description: 'Vercel deployment smoke',
          body: '日本語部分文字列とKnowledgeGraphの検索確認',
          why: 'deployment verification',
          how_to_apply: 'after each deployment',
          entities: [{ name: 'Vercel' }, { name: 'KnowledgeGraph' }],
          triples: [['Vercel', 'serves', 'KnowledgeGraph']],
        },
      },
    });
    saved = true;
    resultText(savedResponse);

    const searchResponse = await call(baseUrl, projectId, token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'search_memories',
        arguments: { query: '部分文字列', query_entities: ['Vercel'] },
      },
    });
    const searchText = JSON.parse(resultText(searchResponse)) as Array<{ name?: string }>;
    if (!searchText.some((item) => item.name === name)) throw new Error('smoke memory not found in search');

    const getResponse = await call(baseUrl, projectId, token, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_memory', arguments: { id_or_name: name } },
    });
    const memoryText = resultText(getResponse);
    if (!memoryText.includes(name)) throw new Error('smoke memory not found in get');

    const ui = await fetch(
      baseUrl + '/p/' + encodeURIComponent(projectId) + '/memories/' + encodeURIComponent(name),
      { redirect: 'manual', headers: protectionHeaders(process.env.VERCEL_AUTOMATION_BYPASS_SECRET) },
    );
    if (ui.status >= 500) throw new Error('memory UI unavailable');

    const dashboard = await fetch(baseUrl + '/dashboard', { redirect: 'manual', headers: protectionHeaders(process.env.VERCEL_AUTOMATION_BYPASS_SECRET) });
    if (dashboard.status >= 500) throw new Error('dashboard unavailable');
  } finally {
    if (saved) {
      await call(baseUrl, projectId, token, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'forget_memory', arguments: { id_or_name: name } },
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  smoke()
    .then(() => console.log('Vercel smoke: PASS'))
    .catch(() => {
      console.error('Vercel smoke: FAIL');
      process.exitCode = 1;
    });
}

export { assertTools, requestHeaders, smoke };
