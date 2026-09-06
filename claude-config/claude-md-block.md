<!-- ltm:begin -->
# long-term-memory MCP MUST rules

1. Before every non-trivial task, call search_memories at least once. Fetch the full body of relevant results with get_memory before acting.
2. Do not load the complete get_memory_index at session start. Use search_memories, search_by_tag, or list_memories_by_type as the entry point.
3. 機密情報は保存しない。Credentials, tokens, private data, and raw environment values never belong in memory.
4. 長期保存先は MCP側を優先し、Claude Code の auto memory との二重保存を避ける。
5. Durable preferences, corrections, decisions, and reusable gotchas are written actively without確認不要の質問を挟まない。
6. subagent には、作業前に search_memories を呼び、関連結果を get_memory で読むことを明示する。
<!-- ltm:end -->
