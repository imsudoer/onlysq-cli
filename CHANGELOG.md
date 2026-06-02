# Changelog

## 0.2.0 — 2026-06-02

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
- Improved round buttons for Send/Stop with SVG arrows.

## 0.1.0 — 2026-06-01

- Initial release.
- Chat, agent mode, inline completions.
- Apply/Reject diff preview for file edits.
- Token usage in status bar.
- Persistent chat history.

## 0.1.6

- Added smooth scroll, etc.

## 0.1.7

- New fileedit tool, smoother animations, scroll fix

## 0.1.8 — 2026-06-02

- **Pause/Resume** — pause agent between steps; model can call `pause_agent` to ask for review.
- **ask_user tool** — agent asks questions with free-form or multiple-choice; UI renders interactive cards.
- **Streaming animations** — thin blinking cursor, 3-dot bounce status pill, slide-in chunks.
- **Disabled auto-trim during runs** — DOM no longer randomly cleared mid-agent.
