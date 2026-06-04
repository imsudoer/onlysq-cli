<p align="center">
  <img src="media/icon.png" width="100" alt="OnlySq CLI">
</p>

<h1 align="center">OnlySq CLI</h1>

<p align="center">
  <strong>AI coding agent for VS Code</strong><br>
  Chat · Agent mode · Inline completions · MCP · Semantic search
</p>

<p align="center">
  <a href="https://my.onlysq.ru"><img src="https://img.shields.io/badge/OnlySq-Dashboard-fd6b03?style=flat-square" alt="Dashboard"></a>
  <img src="https://img.shields.io/badge/VS_Code-1.85+-007ACC?style=flat-square&logo=visualstudiocode" alt="VS Code 1.85+">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT">
</p>

---

## ✨ Features

### 💬 Chat

- Stream responses from **any OnlySq-hosted model** — GPT, Claude, Gemini, Grok, DeepSeek, Qwen and more
- **Three modes**: Agent ⚡ (autonomous tool use), Chat 💬 (conversation), Plan 📋 (read-only analysis)
- **Model badge** on every response — always see which model answered
- **@-mentions** — type `@filename` to attach workspace files as context
- **Drag & drop** files and images directly into the composer
- **Multi-chat** with search, rename, and persistent history
- **Export** any conversation as Markdown or JSON
- **Slash commands** — `/model`, `/memory`, `/export`, `/clear`, `/help`

### 🤖 Agent

Autonomous coding agent with **37 built-in tools** and up to 500 steps per run.

| Category | Tools |
|---|---|
| **File ops** | `read_file`, `propose_edit`, `replace_in_file`, `apply_at_line`, `patch_file`, `delete_file`, `rename_file` |
| **Search** | `search` (regex), `semantic_search` (embeddings), `find_files` (glob), `find_in_file` |
| **Shell** | `run_command`, `run_command_interactive`, `terminal` (persistent sessions) |
| **Git** | `git_status`, `git_diff`, `git_commit` |
| **Web** | `fetch_url`, `web_search`, `scrape_page`, `open_in_browser` |
| **Editor** | `open_file`, `goto_position`, `get_cursor`, `get_selection`, `get_diagnostics` |
| **VS Code** | `run_vscode_command`, `run_task`, `list_tasks` |
| **Memory** | `add_memory`, `get_memory`, `view_memories`, `delete_memory` |
| **Tasks** | `create_task`, `update_task`, `delete_task`, `list_agent_tasks` |
| **Context** | `read_project_context`, `update_project_context`, `workspace_info`, `system_info` |
| **Control** | `pause_agent`, `ask_user`, `delegate` (to sub-agents) |

**Live diff preview** — every file edit opens a native VS Code diff with Apply / Reject buttons. Batch operations with **Apply All / Reject All** and **Undo**.

**Cancel button** — kill hanging `run_command` or `terminal` operations mid-execution.

### 🧠 Sub-Agents

The agent can `delegate` tasks to 8 specialized sub-agents that run in isolated contexts:

| Sub-agent | Purpose |
|---|---|
| `code_reviewer` | Find bugs and security issues (read-only) |
| `code_writer` | Implement code changes |
| `test_runner` | Run and fix tests |
| `explorer` | Explore and explain codebase structure (read-only) |
| `shell_operator` | DevOps and system tasks |
| `refactorer` | Restructure code preserving behavior |
| `doc_writer` | Write documentation |
| `planner` | Break complex goals into steps (read-only) |

### 🔌 MCP (Model Context Protocol)

Connect external tool servers via the [MCP standard](https://modelcontextprotocol.io). Any MCP server works — GitHub, Postgres, Slack, filesystem, and hundreds more.

```jsonc
// .onlysq/mcp.json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  }
}
```

- **UI panel** in chat header — add, remove, enable/disable, restart servers
- **Hot reload** — edit `mcp.json` and servers restart automatically
- **Commands**: `OnlySq: MCP — Edit Config`, `MCP — Reload Servers`, `MCP — Status`

### 🔍 Semantic Search

Natural-language search across your entire workspace using embedding vectors.

1. **`OnlySq: Reindex Workspace`** — scans files, chunks text, generates embeddings
2. Agent uses `semantic_search` tool — finds code by *meaning*, not exact keywords
3. Incremental updates — unchanged files are skipped on re-index

Configurable embedding model: `gemini-embedding-001` (default), `gemini-embedding-2`, `pplx-embed-*`.

### ⌨️ Inline Completions

AI-powered autocomplete in any language. Triggered as you type or on demand.

### 🖥️ Live Terminal Sessions

Persistent shell sessions shared between you and the agent:

- Agent opens a terminal → you see it in VS Code
- You type in the terminal → agent sees your input on its next step
- Full `open` / `write` / `read` / `peek` / `close` / `list` lifecycle

### 💾 Persistent Memory & Tasks

- **Memory** — key-value store that survives across sessions. Agent remembers your preferences, SSH keys, project decisions.
- **Tasks** — trackable work items with status (todo → in progress → done). Displayed as compact markers in chat, managed via dedicated panel.
- **Project context** — `.onlysq/context.md` auto-injected into every agent run.

---

## 🚀 Quick Start

1. Install the extension
2. Click the **OnlySq** icon in the Activity Bar
3. Click **Auth with OnlySq** → sign in via browser
4. Start chatting — toggle **Agent** mode with the ⚡ button

---

## ⚙️ Configuration

| Setting | Default | Description |
|---|---|---|
| `onlysq.chatModel` | `gpt-4o-mini` | Model for chat and agent |
| `onlysq.completionModel` | `gpt-4o-mini` | Model for inline completions |
| `onlysq.embeddingModel` | `gemini-embedding-001` | Model for semantic search index |
| `onlysq.temperature` | `0.3` | LLM temperature (0–2) |
| `onlysq.agent.maxSteps` | `50` | Max agent loop iterations (1–300) |
| `onlysq.agent.parallelTools` | `true` | Run independent tools in parallel |
| `onlysq.agent.toolCache` | `true` | Cache read-only tool results within a run |
| `onlysq.agent.toolPolicy` | `{}` | Per-tool approval: `always` / `ask` / `never` / `disabled` |
| `onlysq.agent.customSystemPrompt` | `""` | Custom instructions appended to system prompt |
| `onlysq.agent.personalization` | `false` | Let agent learn your style from conversations |
| `onlysq.chat.persistHistory` | `true` | Persist chat history between sessions |
| `onlysq.inlineCompletions.enabled` | `true` | Enable inline completions |

Full list: `Ctrl+,` → search **"OnlySq"**.

---

## 🎹 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+O` | Open chat |
| `Ctrl+Alt+N` | New chat |
| Right-click → **Explain Selection** | Explain selected code |
| Right-click → **Refactor Selection** | Refactor selected code |

---

## 📋 Commands

Open the Command Palette (`Ctrl+Shift+P`) and type **OnlySq**:

| Command | Description |
|---|---|
| Open Chat | Focus the chat panel |
| New Chat | Start a fresh conversation |
| Run Agent… | Prompt the agent with a goal |
| Select Chat Model | Pick from available models |
| Select Completion Model | Pick completion model |
| Open Settings | Open in-chat settings panel |
| Initialize Project Context | Auto-generate `.onlysq/context.md` |
| Reindex Workspace | Build semantic search index |
| Drop Semantic Index | Delete the index |
| MCP — Edit Config | Open `.onlysq/mcp.json` |
| MCP — Reload Servers | Restart all MCP servers |
| MCP — Status | Show server status in log |
| Show Log | Open extension output channel |
| Reset Token Usage | Reset session token counter |

---

## 🗂️ Project Files

| File | Purpose |
|---|---|
| `.onlysq/context.md` | Persistent project context, auto-injected into every agent run |
| `.onlysq/mcp.json` | MCP server configuration |
| `.onlysq/index.json` | Semantic search index (auto-generated) |
| `.onlysq` / `.onlysq-rules` / `.onlysq.md` | Project rules, auto-read as custom instructions |

---

## Requirements

- **VS Code** 1.85+
- **OnlySq account** — [my.onlysq.ru](https://my.onlysq.ru)

## License

MIT
