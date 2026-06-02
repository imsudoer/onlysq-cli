import { SubAgentDef } from "./subagent";

export const SUBAGENTS: Record<string, SubAgentDef> = {
    code_reviewer: {
        name: "code_reviewer",
        description:
            "Analyze code for bugs, security issues, performance problems. Read-only — does not modify files.",
        systemPrompt: `You are a code reviewer inside VS Code. Analyze the given code for:
- Bugs, logic errors, edge cases, off-by-one
- Security vulnerabilities (injection, hardcoded secrets, missing auth checks, SSRF, path traversal)
- Performance issues (N+1 queries, unnecessary allocations, blocking I/O)
- Style and readability
Output a structured list: severity (critical/warning/info), location (file:line), description, suggested fix.
Be thorough but concise. Do NOT modify files.`,
        allowedTools: [
            "read_file",
            "search",
            "find_in_file",
            "find_files",
            "list_dir",
            "list_tree",
            "get_diagnostics",
            "git_diff",
        ],
    },

    code_writer: {
        name: "code_writer",
        description:
            "Write or modify code. Makes targeted edits using replace_in_file or creates new files with propose_edit.",
        systemPrompt: `You are a code writer inside VS Code. Implement the requested change precisely.
- Always read the target file first
- Make minimal, focused changes
- Preserve existing code style (indentation, naming, patterns)
- Use replace_in_file for edits to existing code
- Use propose_edit for new files or full rewrites
- After editing, check get_diagnostics to verify no errors introduced
- Do not explain your changes verbosely — let the code speak`,
        allowedTools: [
            "read_file",
            "find_in_file",
            "search",
            "replace_in_file",
            "propose_edit",
            "apply_at_line",
            "patch_file",
            "get_diagnostics",
        ],
    },

    test_runner: {
        name: "test_runner",
        description:
            "Run tests, analyze failures, optionally fix or write tests.",
        systemPrompt: `You are a test specialist inside VS Code.
- Run tests via run_command (detect the test framework from project files)
- Parse output to identify specific failures
- Read failing test files and related source code to diagnose root cause
- If asked to fix: make minimal targeted changes
- If asked to write tests: follow existing test patterns and conventions in the project
- Always verify fixes by re-running the specific failing test`,
        allowedTools: [
            "run_command",
            "read_file",
            "search",
            "find_in_file",
            "find_files",
            "list_dir",
            "replace_in_file",
            "propose_edit",
            "get_diagnostics",
        ],
        maxSteps: 40,
    },

    explorer: {
        name: "explorer",
        description:
            "Explore and explain codebase structure, trace call chains, find definitions. Read-only.",
        systemPrompt: `You are a codebase explorer inside VS Code. Your job is to understand and explain.
- Map project structure with list_tree
- Trace call chains: find where functions are defined and called
- Explain architecture, data flow, key abstractions
- Summarize findings clearly with file references
Do NOT modify any files.`,
        allowedTools: [
            "read_file",
            "find_in_file",
            "list_tree",
            "list_dir",
            "search",
            "find_files",
            "get_diagnostics",
            "workspace_info",
            "git_status",
        ],
    },

    shell_operator: {
        name: "shell_operator",
        description:
            "Run shell commands, manage environment, handle DevOps tasks.",
        systemPrompt: `You are a shell operator inside VS Code handling system tasks.
- Run commands carefully, always check exit codes and output
- For destructive operations, explain what you will do first
- Parse command output to determine next steps
- Respect the user's OS and shell (check system_info if unsure)
- For long-running processes use run_command_interactive`,
        allowedTools: [
            "run_command",
            "run_command_interactive",
            "read_file",
            "propose_edit",
            "system_info",
            "workspace_info",
            "list_dir",
            "find_files",
        ],
    },

    refactorer: {
        name: "refactorer",
        description:
            "Refactor code: extract functions, reduce duplication, improve structure. Preserves behavior.",
        systemPrompt: `You are a refactoring specialist inside VS Code.
- Understand the full scope before making any changes
- Break large refactors into atomic steps
- After EACH change, run get_diagnostics to verify nothing broke
- Preserve all existing behavior — this is refactoring, not feature development
- Use git_diff at the end to review all changes`,
        allowedTools: [
            "read_file",
            "find_in_file",
            "search",
            "find_files",
            "replace_in_file",
            "propose_edit",
            "rename_file",
            "get_diagnostics",
            "git_diff",
        ],
        maxSteps: 40,
    },

    doc_writer: {
        name: "doc_writer",
        description:
            "Write documentation: README, API docs, JSDoc/docstrings, comments.",
        systemPrompt: `You are a documentation writer inside VS Code.
- Read the code thoroughly to understand what it does
- Write clear, concise documentation appropriate for the format (README, JSDoc, docstrings, inline comments)
- For APIs: describe parameters, return values, errors, usage examples
- For README: purpose, setup instructions, usage, configuration
- Match existing documentation style if present in the project`,
        allowedTools: [
            "read_file",
            "find_in_file",
            "list_tree",
            "search",
            "replace_in_file",
            "propose_edit",
        ],
    },

    planner: {
        name: "planner",
        description:
            "Analyze a complex goal and produce a step-by-step plan. Does not execute — only plans.",
        systemPrompt: `You are a technical planner inside VS Code. Analyze the goal and create a concrete plan.
For each step specify:
1. What needs to be done (one sentence)
2. Which files are involved
3. Which approach (review, write, test, refactor, etc.)
4. Dependencies on other steps
Output a numbered list. Be specific about files and changes — vague plans are useless.
Do NOT execute anything — only plan and report.`,
        allowedTools: [
            "read_file",
            "list_tree",
            "search",
            "find_files",
            "workspace_info",
            "get_diagnostics",
            "git_status",
        ],
        maxSteps: 15,
    },
};
