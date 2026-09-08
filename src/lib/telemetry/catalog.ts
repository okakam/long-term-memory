import type { TelemetryKind } from './store';

export const TOOL_CATALOG: Array<{ tool: string; kind: TelemetryKind }> = [
  { tool: 'remember_user_fact', kind: 'write' },
  { tool: 'remember_reference', kind: 'write' },
  { tool: 'remember_session_summary', kind: 'write' },
  { tool: 'remember_feedback', kind: 'write' },
  { tool: 'remember_project_fact', kind: 'write' },
  { tool: 'update_memory', kind: 'write' },
  { tool: 'forget_memory', kind: 'write' },
  { tool: 'link_memories', kind: 'write' },
  { tool: 'list_memories_by_type', kind: 'read' },
  { tool: 'search_by_tag', kind: 'read' },
  { tool: 'find_related', kind: 'read' },
  { tool: 'search_memories', kind: 'read' },
  { tool: 'get_memory', kind: 'read' },
  { tool: 'get_memory_index', kind: 'read' },
  { tool: 'list_projects', kind: 'meta' },
  { tool: 'reindex', kind: 'meta' },
];
