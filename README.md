# It’s My Pi

This is a fork of [Pi](https://github.com/earendil-works/pi). For Pi installation, configuration, tools, providers, extensions, sessions, and general development instructions, use the upstream repository and documentation.

## Added in this fork

### Project-scoped durable memory

Memory is stored locally per Git project at `~/.pi/agent/project-memory/<project-id>/memory.sqlite`. It is not committed to the repository. The project ID uses the `origin` URL when available, so worktrees share the same project memory.

- Reflections marked as `convention`, `decision`, `failure`, or `procedure` become project-memory candidates.
- Candidates are corroborated across distinct sessions with local SQLite FTS5/BM25 matching.
- When a candidate has support from two sessions, Pi asks for an individual approval while idle.
- Approved memories enter the searchable archive. You can explicitly promote a memory to the 1,200-token always-on core; if the core is full, choose a record to demote back to the archive.
- Core memory is injected into every session. Archive memory is retrieved for the first prompt and after compaction, then retained as a bounded session packet.
- The agent gets read-only `memory_search` and `memory_evidence` tools. `memory_evidence` returns the source session and entry references plus a compact excerpt.
- Say `forget ...` to trigger a confirmation dialog that removes a matching approved memory from retrieval and context.

Project memory is fallible context, not authority: current user instructions, repository files, and command output take precedence.

For all other instructions, see [upstream Pi](https://github.com/earendil-works/pi).
