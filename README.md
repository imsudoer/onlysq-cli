# OnlySq CLI

AI coding assistant powered by OnlySq.

## Features

-   **Chat** with any OnlySq-hosted model (GPT, Claude, Gemini, Grok, DeepSeek, Qwen...)
-   **Agent mode** with file edits via native VS Code diff preview
-   **Inline completions** in any language
-   **Token usage** tracking in status bar
-   **Multi-tool support**: read/write files, run commands, git, tasks, search, diagnostics
-   **@-mentions** — type `@filename` to attach workspace files as context
-   **Drag & drop** files and images into the chat
-   **Apply All / Reject All** — batch manage multiple pending file edits
-   **Undo** — revert the last applied file edit with one click
-   **Export** — save any chat as Markdown or JSON
-   **Code blocks** with syntax highlighting, language label, and copy button

## Quick start

1. Install the extension.
2. Click the OnlySq icon in the Activity Bar.
3. Click **Auth with OnlySq** and sign in via your browser.
4. Start chatting. Toggle the **A** button for Agent mode.

## Configuration

| Setting                      | Default       | Description                            |
| ---------------------------- | ------------- | -------------------------------------- |
| `onlysq.chatModel`           | `gpt-4o-mini` | Model for chat and agent               |
| `onlysq.completionModel`     | `gpt-4o-mini` | Model for inline completions           |
| `onlysq.approval.write`      | `ask`         | Approval policy for file edits         |
| `onlysq.approval.shell`      | `ask`         | Approval policy for shell commands     |
| `onlysq.agent.parallelTools` | `true`        | Run independent tool calls in parallel |
| `onlysq.chat.persistHistory` | `true`        | Persist chat history between sessions  |

See `Ctrl+,` → search "OnlySq" for all options.

## Requirements

-   VS Code 1.85+
-   An OnlySq account: https://my.onlysq.ru

## License

MIT
