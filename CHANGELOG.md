# Changelog

## 0.2.237 — 2026-06-04

### Semantic Search
- **Workspace indexer** — incremental chunking of all workspace files with embedding vectors.
- **`semantic_search` tool** — agent searches code by meaning, not literal text. Returns top-K ranked chunks with file path, line range, and score.
- **`OnlySq: Reindex Workspace`** command with progress notification and cancel support.
- **`OnlySq: Drop Semantic Index`** command.
- **Configurable embedding model** — `gemini-embedding-001` (default), `gemini-embedding-2`, `pplx-embed-*` family.
- **Hot cache** — 10-second in-memory cache of the index for fast sequential searches.
- **FileSystemWatcher** on `.onlysq/index.json` — cache auto-invalidates on external changes.

### MCP (Model Context Protocol)
- **Full MCP support** via `@modelcontextprotocol/sdk` — spawn stdio-based MCP servers, proxy their tools into the agent's tool registry.
- **`.onlysq/mcp.json`** config — supports both `servers` and `mcpServers` keys (compatible with Cursor/Claude Desktop).
- **MCP panel** in chat header (green-cyan palette) — add, remove, enable/disable, restart servers. View tools per server with expandable list.
- **Hot reload** — `FileSystemWatcher` on `mcp.json` auto-restarts servers on save.
- **Commands**: `MCP — Edit Config`, `MCP — Reload Servers`, `MCP — Status`.

### Memory UI
- **Memory panel** in chat header (violet palette) — full CRUD for persistent agent memories.
- **Search** — instant filter by key or value.
- **Inline editing** — click key to rename (contenteditable), click value to edit. Ctrl+Enter to save.
- **Collapsible values** — long values auto-collapse with "Show more / Show less" toggle.
- **Badge** on header button — shows total memory count.
- **`MemoryStore`** now emits `onChange` events + `rename(oldKey, newKey)` method.

### Terminal Sessions
- **Live terminal sharing** — user types in a terminal → agent receives `(User just typed in a live terminal...)` system message before next step.
- **`peek` action** — view terminal buffer without clearing it.
- **User input tracking** — `userInputBuffer`, `userInputChars`, `lastUserInputAt` per session.
- **Global `onUserInput` emitter** — real-time events for all subscribers.
- **`list` action** enhanced — shows `user-typed=Nch` if there's unprocessed input.
- **`read` action** enhanced — appends `[USER TYPED in terminal since last read]` block.

### Cancel Button
- **Cancel button** on `run_command`, `run_command_interactive`, and `terminal` tool blocks.
- Red `×` button appears next to spinner while tool is running.
- Sends `SIGTERM` → waits 1.5s → `SIGKILL` to the child process.
- `cancelRegistry` — central register/unregister/cancel mechanism for tool calls.

### UI / Design
- **Model badge** — assistant messages show the model name (e.g. `claude-opus-4-7`) in a styled badge instead of "OnlySq".
- **Token reveal animation** — streaming text appears character-by-character with wave effect (`wrapFreshTokens`). Up to 50 chars animated per token, 260ms cubic-bezier, staggered by 8ms per char.
- **Unified panel glow** — all floating panels share the same visual language:
  - Tasks — orange (`#fd6b03`)
  - Memory — violet (`#8b78ff`)
  - MCP — green-cyan (`#2ec4b6`)
  - Chats, modals, mention popup, export menu, multi-diff bar — orange accent glow
- **Tasks panel upgraded** — orange border glow, gradient header, accent-colored title, hover effect on icon.
- **Task markers in history** — loading a saved chat now renders `create_task` / `update_task` / `delete_task` as compact markers (dot + label) instead of full tool blocks.

### Agent
- **System prompt rule #14** — agent is instructed to acknowledge user terminal input and adjust behavior.
- **System prompt rule #15** — agent must say "I don't know" instead of confabulating; verify via tools.
- **`ToolRegistry`** — added `unregister`, `unregisterPrefix`, `has` methods for MCP tool lifecycle.

---

## 0.2.0 & 0.2.1 — 2026-06-02

### Sub-agents

- **`delegate` tool** — the agent can now delegate tasks to 8 specialized sub-agents:
    - `code_reviewer` — find bugs, security issues (read-only)
    - `code_writer` — implement code changes
    - `test_runner` — run and fix tests
    - `explorer` — explore codebase structure (read-only)
    - `shell_operator` — DevOps/system tasks
    - `refactorer` — restructure code preserving behavior
    - `doc_writer` — write documentation
    - `planner` — break complex goals into steps (read-only)
- Sub-agents run in isolated contexts with limited tool sets and own system prompts.

### UI / Design

- **SVG icons** — all header, toolbar, and action buttons now use clean inline SVG icons instead of text characters.
- **Wave thinking indicator** — three dots animate in a wave pattern instead of the old pulsing pill.
- **Enhanced Markdown rendering** — code blocks have a language label header and a **Copy** button; markdown tables render as proper HTML.
- **@-mentions** — type `@` in the chat to search and attach workspace files as context with autocomplete popup.
- **Drag & drop files/images** — drop files or images directly into the chat composer.
- **Multi-file diff preview** — **Apply All / Reject All** bar for 2+ pending edits.
- **Undo last edit** — instantly revert the last applied file change.
- **Export chat** — save conversation as **Markdown** or **JSON**.

### Agent

- **Live messages during run** — send messages while the agent is working; they are injected into the next iteration.
- **Web tools** — `fetch_url`, `web_search` (DuckDuckGo), `scrape_page` (HTML → text).
- **`git_commit` tool** — stage changes and commit with a message.
- **Custom system prompt** — append custom instructions via settings.
- **Personalization toggle** — let the agent learn your preferences.
- **Disabled tools** — disable specific tools by name in settings.
- **Per-tool approval** — separate approval policy for web requests.

### Bug fixes

- **Fixed flicker** — streaming no longer re-triggers CSS animations on every token.
- **Fixed pause double-press** — `pause_agent` tool now correctly pauses on first press.
- **Fixed chats button SVG** — click on SVG icon inside button now works.
- **Pause button redesign** — round button with SVG pause/play icons matching send/stop.

### UI

- **Tool grouping** — 3+ consecutive completed tools collapse into "N completed tools" with expand button.
- **Reasoning display** — `<thinking>` blocks render in collapsible italic blocks.
- **Token counter** — approximate token count shown per message.
- **Context pins** — pin files as persistent context for the session.
- **Image preview** — attached images show thumbnail previews in the composer.

---

## 0.1.8 — 2026-06-02

- **Pause/Resume** — pause agent between steps; model can call `pause_agent` to ask for review.
- **ask_user tool** — agent asks questions with free-form or multiple-choice; UI renders interactive cards.
- **Streaming animations** — thin blinking cursor, 3-dot bounce status pill, slide-in chunks.
- **Disabled auto-trim during runs** — DOM no longer randomly cleared mid-agent.

## 0.1.7

- New file-edit tool, smoother animations, scroll fix.

## 0.1.6

- Smooth scroll and minor improvements.

## 0.1.0 — 2026-06-01

- Initial release.
- Chat, agent mode, inline completions.
- Apply/Reject diff preview for file edits.
- Token usage in status bar.
- Persistent chat history.
