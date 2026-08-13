# It’s My Pi

This is a fork of [Pi](https://github.com/earendil-works/pi). For Pi installation, configuration, tools, providers, extensions, sessions, and general development instructions, use the upstream repository and documentation.

## Added in this fork

1. **In-session memory and compaction.** An observer records useful observations, a reflector turns them into concise decisions, conventions, failures, and procedures, and the agent retains that working memory across context compaction.

2. **Durable project memory for self-learning agents.** Reflections can become locally stored, project-scoped memories. Repeated evidence across sessions triggers approval; approved memories are retrieved in later sessions. Memory lives outside Git under `~/.pi/agent/project-memory/`.

For all other instructions, see [upstream Pi](https://github.com/earendil-works/pi).
