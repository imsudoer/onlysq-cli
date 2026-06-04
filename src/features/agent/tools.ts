import * as vscode from "vscode";
import { ToolHandler } from "./toolRegistry";
import {
    listDir,
    listTree,
    readText,
    searchText,
    findFiles,
    exists,
    stat,
    deleteFile,
    renameFile,
    resolve,
    rel as toRel,
    getDiagnostics,
    readTextWithLineNumbers,
} from "../../services/workspace/fs";
import {
    createProposal,
    showDiff,
    applyProposal,
    rejectProposal,
    hasPendingEdits,
    waitForPendingEdits,
} from "../../services/workspace/diffPreview";
import { runInTerminal } from "../../services/workspace/terminal";
import {
    openSession,
    writeToSession,
    readFromSession,
    closeSession,
    listSessions,
    showSession,
    peekSession,
} from "../../services/workspace/terminalSession";
import {
    executeShell,
    formatShellResult,
} from "../../services/workspace/shell";
import { applyUnifiedDiff } from "../../services/workspace/patch";
import { previewLineEdit, LineEdit } from "../../services/workspace/lineEdit";
import { gotoLocation, getCursor } from "../../services/workspace/editorOps";
import { gitStatus, gitDiff } from "../../services/workspace/git";
import { listTasks, runTaskByName } from "../../services/workspace/tasks";
import { systemInfo } from "../../core/systemInfo";
import { askToolApproval } from "./approval";
import { settings } from "../../core/config";
import {
    previewReplaceInFile,
    ReplaceOp,
} from "../../services/workspace/replaceInFile";
import {
    readProjectContext,
    writeProjectContext,
    projectContextPath,
    hasProjectContext,
} from "../../services/workspace/projectContext";
import { SUBAGENTS } from "./subagentDefs";
import { fetchUrl, webSearch, scrapePage } from "../../services/workspace/web";
import type { MemoryStore } from "../../services/memory/memoryStore";

let _memoryStore: MemoryStore | undefined;
export function setMemoryStore(store: MemoryStore): void {
    _memoryStore = store;
}

export interface AgentTask {
    id: string;
    text: string;
    status: "todo" | "in_progress" | "done";
}
const agentTasks: AgentTask[] = [];
let taskCounter = 0;

type TasksListener = (tasks: AgentTask[]) => void;
const tasksListeners = new Set<TasksListener>();

interface TasksStore {
    get<T>(key: string, def: T): T;
    update(key: string, value: any): Thenable<void>;
}
let tasksStore: TasksStore | undefined;
const TASKS_KEY = "onlysq.agentTasks.v1";
const COUNTER_KEY = "onlysq.agentTasks.counter";

export function initAgentTasksStore(store: TasksStore): void {
    tasksStore = store;
    try {
        const saved = store.get<AgentTask[]>(TASKS_KEY, []);
        const counter = store.get<number>(COUNTER_KEY, 0);
        agentTasks.length = 0;
        if (Array.isArray(saved)) {
            for (const t of saved) {
                if (t && typeof t.id === "string" && typeof t.text === "string") {
                    agentTasks.push({
                        id: t.id,
                        text: t.text,
                        status: (t.status === "todo" || t.status === "in_progress" || t.status === "done") ? t.status : "todo",
                    });
                }
            }
        }
        taskCounter = Math.max(counter, ...agentTasks.map((t) => {
            const m = /^task-(\d+)$/.exec(t.id);
            return m ? Number(m[1]) : 0;
        }), 0);
        if (agentTasks.length) emitTasksChange();
    } catch {
        /* ignore corrupted state */
    }
}

function persistTasks(): void {
    if (!tasksStore) return;
    try {
        void tasksStore.update(TASKS_KEY, agentTasks.map((t) => ({ ...t })));
        void tasksStore.update(COUNTER_KEY, taskCounter);
    } catch { /* ignore */ }
}

function emitTasksChange(): void {
    persistTasks();
    const snapshot = agentTasks.map((t) => ({ ...t }));
    for (const l of tasksListeners) {
        try { l(snapshot); } catch { /* ignore */ }
    }
}

export function getAgentTasks(): AgentTask[] {
    return agentTasks.map((t) => ({ ...t }));
}

export function onAgentTasksChange(listener: TasksListener): () => void {
    tasksListeners.add(listener);
    return () => tasksListeners.delete(listener);
}

export function clearAgentTasks(): void {
    if (!agentTasks.length) {
        if (tasksStore) persistTasks();
        return;
    }
    agentTasks.length = 0;
    emitTasksChange();
}

export function addUserTask(text: string, status: AgentTask["status"] = "todo"): AgentTask {
    const id = "task-" + (++taskCounter);
    const task: AgentTask = { id, text, status };
    agentTasks.push(task);
    emitTasksChange();
    return { ...task };
}

export function editTaskText(id: string, text: string): boolean {
    const t = agentTasks.find((x) => x.id === id);
    if (!t) return false;
    t.text = text;
    emitTasksChange();
    return true;
}

export function setTaskStatus(id: string, status: AgentTask["status"]): boolean {
    const t = agentTasks.find((x) => x.id === id);
    if (!t) return false;
    t.status = status;
    emitTasksChange();
    return true;
}

export function deleteAgentTask(id: string): boolean {
    const idx = agentTasks.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    agentTasks.splice(idx, 1);
    emitTasksChange();
    return true;
}

const obj = (props: Record<string, any>, required: string[] = []) => ({
    type: "object",
    properties: props,
    required,
});
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const arr = (items: any, description: string) => ({
    type: "array",
    items,
    description,
});

type EditResultListener = (id: string, state: "applied" | "rejected") => void;
const editResultListeners = new Set<EditResultListener>();

export function onEditResultEvent(listener: EditResultListener): () => void {
    editResultListeners.add(listener);
    return () => editResultListeners.delete(listener);
}

function emitEditResult(id: string, state: "applied" | "rejected"): void {
    for (const l of editResultListeners) {
        try { l(id, state); } catch { /* ignore */ }
    }
}

async function finalizeEditProposal(
    proposalId: string,
    path: string,
    reason: string | undefined,
    actionLabel: string,
    toolName: string = "propose_edit"
): Promise<string> {
    const mode = settings().toolPolicy[toolName] ?? "ask";
    if (mode === "always") {
        await applyProposal(proposalId);
        emitEditResult(proposalId, "applied");
        return `${actionLabel} applied to ${path} (auto-approved).${
            reason ? `\nReason: ${reason}` : ""
        }`;
    }
    if (mode === "never") {
        rejectProposal(proposalId);
        emitEditResult(proposalId, "rejected");
        return `${actionLabel} to ${path} rejected by approval policy.`;
    }
    void showDiff(proposalId);
    return `Proposed ${actionLabel.toLowerCase()} to ${path}. Awaiting user review.${
        reason ? `\nReason: ${reason}` : ""
    }`;
}

export const builtinTools: ToolHandler[] = [
    {
        def: {
            type: "function",
            function: {
                name: "pause_agent",
                description:
                    "Pause the agent after the current step and wait for the user to resume. " +
                    "Use when user review, manual action, or confirmation is needed before continuing.",
                parameters: obj(
                    {
                        reason: str(
                            "Why you are pausing and what the user should check or do"
                        ),
                    },
                    ["reason"]
                ),
            },
        },
        run: async ({ reason }: { reason: string }) => {
            return String(reason || "Paused by model");
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "ask_user",
                description:
                    "Ask the user a question and wait for their answer. Use when you need clarification, confirmation, or a choice. " +
                    "For yes/no or multiple-choice, provide options array. For free-form input, omit options. " +
                    "The agent will pause until the user responds.",
                parameters: obj(
                    {
                        question: str("The question to ask"),
                        options: {
                            type: "array",
                            items: str(""),
                            description:
                                "Optional list of choices. If provided, user picks one or more. If omitted, user types free-form.",
                        },
                        multi_select: {
                            type: "boolean",
                            description:
                                "Allow selecting multiple options. Default false.",
                        },
                    },
                    ["question"]
                ),
            },
        },
        run: async (_args: any, _ctx) => {
            return "__ASK_USER__";
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "read_file",
                description:
                    'Read a UTF-8 file with line numbers (1-based). Lines are formatted as "  42 | source code". ' +
                    "Line endings (CRLF/LF) are handled automatically — provide expected_lines without trailing carriage returns. " +
                    "For large files, use start_line / end_line to read a specific range.",
                parameters: obj(
                    {
                        path: str("Workspace-relative path"),
                        start_line: num("Optional 1-based start, default 1"),
                        end_line: num(
                            "Optional 1-based end (inclusive), default end of file"
                        ),
                    },
                    ["path"]
                ),
            },
        },
        run: async ({
            path,
            start_line,
            end_line,
        }: {
            path: string;
            start_line?: number;
            end_line?: number;
        }) => {
            const r = await readTextWithLineNumbers(path, {
                start: start_line,
                end: end_line,
            });
            let header = `File: ${path}\nTotal lines: ${r.totalLines}\nLine endings: ${r.eol}`;
            if (r.truncated) header += " (file truncated at 200KB)";
            if (start_line || end_line)
                header += `\nShowing lines ${r.rangeStart}-${r.rangeEnd}`;
            return header + "\n---\n" + r.text;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "list_dir",
                description: "List entries in a directory (one level).",
                parameters: obj({ path: str('Default ".".') }),
            },
        },
        run: async ({ path }: { path?: string }) => {
            const items = await listDir(path ?? ".");
            return (
                items
                    .map((i) => `${i.kind === "dir" ? "d" : "f"} ${i.name}`)
                    .join("\n") || "(empty)"
            );
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "list_tree",
                description: "Recursive tree (limited).",
                parameters: obj({
                    path: str('Root, default ".".'),
                    max_depth: num("Default 3"),
                    max_items: num("Default 200"),
                }),
            },
        },
        run: async (a: any) =>
            (
                await listTree(
                    a.path ?? ".",
                    a.max_depth ?? 3,
                    a.max_items ?? 200
                )
            ).join("\n") || "(empty)",
    },

    {
        def: {
            type: "function",
            function: {
                name: "search",
                description: "Regex search across files.",
                parameters: obj(
                    {
                        pattern: str("JS regex"),
                        glob: str("Default **/*"),
                        limit: num("Default 50"),
                    },
                    ["pattern"]
                ),
            },
        },
        run: async (a: any) =>
            (await searchText(a.pattern, a.glob ?? "**/*", a.limit ?? 50)).join(
                "\n"
            ) || "(no matches)",
    },

    {
        def: {
            type: "function",
            function: {
                name: "find_files",
                description: "Glob-based file search.",
                parameters: obj(
                    {
                        glob: str('e.g. "**/*.ts"'),
                        limit: num("Default 100"),
                    },
                    ["glob"]
                ),
            },
        },
        run: async (a: any) =>
            (await findFiles(a.glob, a.limit ?? 100)).join("\n") ||
            "(no files)",
    },

    {
        def: {
            type: "function",
            function: {
                name: "file_info",
                description: "Path metadata.",
                parameters: obj({ path: str("") }, ["path"]),
            },
        },
        run: async ({ path }: { path: string }) => {
            const s = await stat(path);
            if (!s) return JSON.stringify({ path, exists: false });
            return JSON.stringify(
                {
                    path,
                    exists: true,
                    kind: s.type === vscode.FileType.Directory ? "dir" : "file",
                    size: s.size,
                    mtime: new Date(s.mtime).toISOString(),
                },
                null,
                2
            );
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "find_in_file",
                description:
                    "Find lines in a single file matching a regex, returning matched lines with line numbers and surrounding context. " +
                    "Use this for large files where read_file would truncate or be too long. Returns up to 30 matches.",
                parameters: obj(
                    {
                        path: str("Workspace-relative path"),
                        pattern: str("JS regex"),
                        context: num(
                            "Lines of context around each match, default 2"
                        ),
                    },
                    ["path", "pattern"]
                ),
            },
        },
        run: async ({
            path,
            pattern,
            context,
        }: {
            path: string;
            pattern: string;
            context?: number;
        }) => {
            try {
                const text = await readText(path, 2_000_000);
                const lines = text.split("\n");
                const re = new RegExp(pattern, "g");
                const ctxN = Math.max(0, Math.min(10, context ?? 2));
                const hits: string[] = [];
                for (let i = 0; i < lines.length && hits.length < 30; i++) {
                    re.lastIndex = 0;
                    if (!re.test(lines[i])) continue;
                    const start = Math.max(0, i - ctxN);
                    const end = Math.min(lines.length - 1, i + ctxN);
                    const width = String(end + 1).length;
                    const block = [];
                    for (let j = start; j <= end; j++) {
                        const marker = j === i ? ">" : " ";
                        const n = String(j + 1).padStart(width, " ");
                        block.push(`${marker} ${n} | ${lines[j]}`);
                    }
                    hits.push(block.join("\n"));
                }
                return hits.length
                    ? `File: ${path} (${lines.length} lines)\n\n` +
                          hits.join("\n---\n")
                    : "(no matches)";
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "propose_edit",
                description:
                    "Create a new file or fully overwrite an existing one with new content. " +
                    "Depending on the user's approval policy, the change is either applied immediately, " +
                    "rejected automatically, or presented in the chat with Apply/Reject buttons. " +
                    "Provide the complete new file content (not a diff).",
                parameters: obj(
                    {
                        path: str("Workspace-relative path"),
                        content: str("Full new file content"),
                        reason: str("Short summary of the change"),
                    },
                    ["path", "content"]
                ),
            },
        },
        run: async (a: any, ctx) => {
            const proposal = await createProposal({
                id: ctx.callId,
                path: String(a.path),
                newContent: String(a.content ?? ""),
                reason: a.reason ? String(a.reason) : undefined,
            });
            return finalizeEditProposal(
                proposal.id,
                String(a.path),
                a.reason ? String(a.reason) : undefined,
                "Edit",
                "propose_edit"
            );
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "apply_at_line",
                description:
                    "Modify a specific range of lines in a file. Use this for small, targeted edits. " +
                    "CRITICAL: line numbers are 1-based and refer to the current file state. " +
                    "ALWAYS call read_file first to get correct line numbers. " +
                    "You MUST provide expected_lines — the exact text currently on those lines — for verification.",
                parameters: obj(
                    {
                        path: str("Workspace-relative path"),
                        start_line: num("First line of the range, 1-based"),
                        end_line: num(
                            "Last line, inclusive. Defaults to start_line. Ignored for insert modes."
                        ),
                        replacement: str(
                            "Text to insert or replace with (can span multiple lines)"
                        ),
                        mode: {
                            type: "string",
                            enum: ["replace", "insert_before", "insert_after"],
                            description: 'Default "replace"',
                        },
                        expected_lines: arr(
                            str(""),
                            "REQUIRED. Exact current content of lines [start_line..end_line], one element per line."
                        ),
                        reason: str("Short summary shown to the user"),
                    },
                    ["path", "start_line", "replacement", "expected_lines"]
                ),
            },
        },
        run: async (a: any, ctx) => {
            try {
                const edit: LineEdit = {
                    path: String(a.path),
                    startLine: Number(a.start_line),
                    endLine:
                        a.end_line != null ? Number(a.end_line) : undefined,
                    replacement: String(a.replacement ?? ""),
                    mode:
                        a.mode === "insert_before" || a.mode === "insert_after"
                            ? a.mode
                            : "replace",
                    expectedLines: Array.isArray(a.expected_lines)
                        ? a.expected_lines.map((x: any) => String(x))
                        : undefined,
                };
                if (!Number.isFinite(edit.startLine) || edit.startLine < 1) {
                    return "Error: start_line must be a positive integer (1-based)";
                }
                if (!edit.expectedLines || !edit.expectedLines.length) {
                    return "Error: expected_lines is required. Call read_file first, then provide the exact current content of the target lines.";
                }
                const preview = await previewLineEdit(edit);
                const proposal = await createProposal({
                    id: ctx.callId,
                    path: edit.path,
                    newContent: preview.proposed,
                    reason: a.reason
                        ? String(a.reason)
                        : `${edit.mode} lines ${edit.startLine}${
                              edit.endLine ? `-${edit.endLine}` : ""
                          }`,
                });
                return finalizeEditProposal(
                    proposal.id,
                    edit.path,
                    a.reason ? String(a.reason) : undefined,
                    `${edit.mode} at line ${edit.startLine}`,
                    "apply_at_line"
                );
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "replace_in_file",
                description:
                    "Find-and-replace exact strings inside a file. Most reliable tool for targeted edits — " +
                    "use this instead of apply_at_line/patch_file when you can quote the EXACT current text. " +
                    "Each operation: find the literal string, replace it with new text. By default replaces ALL occurrences; " +
                    "set count to limit. Multi-line strings are supported. Line endings (CRLF/LF) are normalized — write \\n in your strings. " +
                    'If any "find" does not appear in the file, the whole operation FAILS and reports which ones — read the file again and adjust.',
                parameters: obj(
                    {
                        path: str("Workspace-relative path"),
                        operations: {
                            type: "array",
                            description:
                                "List of find/replace operations applied in order to the running content.",
                            items: obj(
                                {
                                    find: str(
                                        "Exact string to find (literal, not regex). Can be multi-line."
                                    ),
                                    replace: str(
                                        "Replacement string. Can be multi-line."
                                    ),
                                    count: num(
                                        "Optional. Max replacements for this operation (default: all)."
                                    ),
                                },
                                ["find", "replace"]
                            ),
                        },
                        reason: str("Short summary shown to the user"),
                        allow_partial: {
                            type: "boolean",
                            description:
                                "If true, succeeds even when some operations did not match. Default false.",
                        },
                    },
                    ["path", "operations"]
                ),
            },
        },
        run: async (a: any, ctx) => {
            try {
                const ops: ReplaceOp[] = Array.isArray(a.operations)
                    ? a.operations
                    : [];
                if (!ops.length)
                    return "Error: operations must be a non-empty array";
                for (let i = 0; i < ops.length; i++) {
                    if (typeof ops[i]?.find !== "string")
                        return `Error: operations[${i}].find must be a string`;
                    if (typeof ops[i]?.replace !== "string")
                        return `Error: operations[${i}].replace must be a string`;
                }

                const result = await previewReplaceInFile(String(a.path), ops);

                if (result.notFound.length && !a.allow_partial) {
                    const lines = result.notFound.map((nf) => {
                        const preview =
                            nf.find.length > 200
                                ? nf.find.slice(0, 200) + "…"
                                : nf.find;
                        const base = `  [${nf.index}] not found: ${JSON.stringify(
                            preview
                        )}`;
                        return nf.hint ? `${base}\n      hint: ${nf.hint}` : base;
                    });
                    return (
                        `Error: ${result.notFound.length}/${ops.length} operations did not match. The file was NOT changed.\n` +
                        lines.join("\n") +
                        `\n\nRe-read the file to verify exact whitespace, indentation, and line endings. ` +
                        `Or pass allow_partial=true to apply only the matching ones.`
                    );
                }

                if (result.totalApplied === 0) {
                    return `Error: no operations matched. The file was NOT changed.`;
                }

                const proposal = await createProposal({
                    id: ctx.callId,
                    path: String(a.path),
                    newContent: result.proposed,
                    reason: a.reason
                        ? String(a.reason)
                        : `Replace ${result.totalApplied} occurrence(s) in ${ops.length} op(s)`,
                });

                const summaryLines = [
                    `Replace in ${a.path}: ${result.totalApplied} replacement(s) across ${result.applied.length}/${ops.length} operation(s).`,
                ];
                for (const op of result.applied) {
                    const tag = op.fuzzy ? " (fuzzy: whitespace-tolerant)" : "";
                    summaryLines.push(
                        `  [${op.index}] ${op.appliedCount}/${op.matchCount} replaced${tag}`
                    );
                }
                if (result.notFound.length) {
                    summaryLines.push(
                        `  ${result.notFound.length} operation(s) skipped (no match)`
                    );
                }

                const finalNote = await finalizeEditProposal(
                    proposal.id,
                    String(a.path),
                    a.reason ? String(a.reason) : undefined,
                    "Replace",
                    "replace_in_file"
                );
                return summaryLines.join("\n") + "\n\n" + finalNote;
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "patch_file",
                description:
                    "Apply a unified diff (with @@ hunks) to an existing file. " +
                    "Use for medium-sized changes across multiple non-adjacent regions. " +
                    "For brand-new files or full rewrites use propose_edit instead.",
                parameters: obj(
                    {
                        path: str("Workspace-relative path"),
                        diff: str(
                            'Unified diff text including @@ hunk headers. Lines start with " ", "+", or "-".'
                        ),
                        reason: str("Short summary shown to the user"),
                    },
                    ["path", "diff"]
                ),
            },
        },
        run: async (a: any, ctx) => {
            try {
                const preview = await applyUnifiedDiff(
                    String(a.path),
                    String(a.diff)
                );
                const proposal = await createProposal({
                    id: ctx.callId,
                    path: String(a.path),
                    newContent: preview.proposed,
                    reason: a.reason ? String(a.reason) : "Unified diff patch",
                });
                return finalizeEditProposal(
                    proposal.id,
                    String(a.path),
                    a.reason ? String(a.reason) : undefined,
                    "Patch",
                    "patch_file"
                );
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "delete_file",
                description: "Move a file or folder to the trash.",
                parameters: obj({ path: str("Workspace-relative path") }, [
                    "path",
                ]),
            },
        },
        run: async ({ path }: { path: string }) => {
            if (
                !(await askToolApproval(
                    "delete_file",
                    `OnlySq agent wants to delete ${path}. Allow?`
                ))
            ) {
                return "User denied delete";
            }
            await deleteFile(path);
            return `Deleted ${path}`;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "rename_file",
                description: "Rename or move a file.",
                parameters: obj(
                    {
                        from: str("Source path"),
                        to: str("Destination path"),
                    },
                    ["from", "to"]
                ),
            },
        },
        run: async ({ from, to }: { from: string; to: string }) => {
            if (
                !(await askToolApproval(
                    "rename_file",
                    `OnlySq agent wants to rename ${from} -> ${to}. Allow?`
                ))
            ) {
                return "User denied rename";
            }
            if (await exists(to)) return `Target already exists: ${to}`;
            await renameFile(from, to);
            return `Renamed ${from} -> ${to}`;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "open_file",
                description:
                    "Open a file in the editor; optionally reveal a line.",
                parameters: obj(
                    {
                        path: str("Workspace-relative path"),
                        line: num("Optional 1-based line to reveal"),
                    },
                    ["path"]
                ),
            },
        },
        run: async ({ path, line }: { path: string; line?: number }) => {
            await gotoLocation(path, line ?? 1, 1);
            return `Opened ${path}${line ? `:${line}` : ""}`;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "goto_position",
                description:
                    "Place the cursor at a specific position or select a range.",
                parameters: obj(
                    {
                        path: str("Workspace-relative path"),
                        line: num("1-based"),
                        column: num("1-based, default 1"),
                        end_line: num("Optional for selection"),
                        end_column: num("Optional, default 1"),
                    },
                    ["path", "line"]
                ),
            },
        },
        run: async (a: any) => {
            const sel =
                a.end_line != null
                    ? {
                          endLine: Number(a.end_line),
                          endColumn: a.end_column ?? 1,
                      }
                    : undefined;
            await gotoLocation(
                String(a.path),
                Number(a.line),
                a.column ?? 1,
                sel
            );
            return sel
                ? `Selected ${a.path}:${a.line}:${a.column ?? 1} → ${
                      a.end_line
                  }:${a.end_column ?? 1}`
                : `Cursor at ${a.path}:${a.line}:${a.column ?? 1}`;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "get_cursor",
                description: "Current cursor position and selection.",
                parameters: obj({}),
            },
        },
        run: async () => {
            const c = await getCursor();
            return c ? JSON.stringify(c, null, 2) : "(no active editor)";
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "get_selection",
                description: "Current selection or active file content.",
                parameters: obj({}),
            },
        },
        run: async () => {
            const ed = vscode.window.activeTextEditor;
            if (!ed) return "(no active editor)";
            const sel = ed.selection;
            const text = ed.document.getText(sel.isEmpty ? undefined : sel);
            return JSON.stringify(
                {
                    file: toRel(ed.document.uri),
                    language: ed.document.languageId,
                    selection: sel.isEmpty
                        ? null
                        : {
                              start: {
                                  line: sel.start.line + 1,
                                  char: sel.start.character,
                              },
                              end: {
                                  line: sel.end.line + 1,
                                  char: sel.end.character,
                              },
                          },
                    text: text.slice(0, 50_000),
                },
                null,
                2
            );
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "list_open_files",
                description: "List currently open editor tabs.",
                parameters: obj({}),
            },
        },
        run: async () => {
            const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
            const out: string[] = [];
            for (const t of tabs) {
                const input: any = t.input;
                if (input?.uri instanceof vscode.Uri)
                    out.push(toRel(input.uri));
            }
            return out.length ? out.join("\n") : "(no open editors)";
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "get_diagnostics",
                description: "Errors and warnings from language servers.",
                parameters: obj({
                    path_filter: str("Optional substring filter"),
                }),
            },
        },
        run: async ({ path_filter }: { path_filter?: string }) => {
            const d = getDiagnostics(path_filter);
            if (!d.length) return "(no diagnostics)";
            return d
                .slice(0, 100)
                .map(
                    (x) =>
                        `${x.file}:${x.line}:${x.column} [${x.severity}]${
                            x.source ? ` (${x.source})` : ""
                        } ${x.message}`
                )
                .join("\n");
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "run_command",
                description:
                    "Run a shell command and capture its full stdout/stderr. " +
                    "Best for builds, tests, scripts. Times out after 30s by default (max 120s).",
                parameters: obj(
                    {
                        command: str("Shell command to execute"),
                        cwd: str("Optional relative working directory"),
                        timeout_ms: num(
                            "Optional timeout in ms, default 30000, max 120000"
                        ),
                    },
                    ["command"]
                ),
            },
        },
        run: async (a: any) => {
            if (hasPendingEdits()) {
                await waitForPendingEdits();
            }
            if (!(await askToolApproval("run_command", `Run: ${a.command}`)))
                return "User denied command";
            const timeout = Math.min(
                Math.max(1000, Number(a.timeout_ms) || 30_000),
                120_000
            );
            const r = await executeShell(String(a.command), {
                cwd: a.cwd,
                timeoutMs: timeout,
            });
            return formatShellResult(r);
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "run_command_interactive",
                description:
                    "Run a long-running command in the OnlySq Agent terminal. " +
                    "User sees output live; this tool returns immediately without capturing output. " +
                    "Use for dev servers, watchers, REPLs.",
                parameters: obj(
                    {
                        command: str("Shell command"),
                        cwd: str("Optional relative cwd"),
                    },
                    ["command"]
                ),
            },
        },
        run: async (a: any) => {
            if (hasPendingEdits()) {
                await waitForPendingEdits();
            }
            if (
                !(await askToolApproval("run_command_interactive", `Start in terminal: ${a.command}`))
            )
                return "User denied command";
            const full = a.cwd ? `cd "${a.cwd}" && ${a.command}` : a.command;
            runInTerminal(String(full), true);
            return `Started in terminal: ${a.command}`;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "terminal",
                description:
                    "Long-lived shell session. Spawn a real shell, send commands to its stdin, read accumulated stdout/stderr later, close when done. " +
                    "Unlike run_command (blocks until process exits) and run_command_interactive (fire-and-forget into VS Code terminal), this lets you keep a session open, send multiple commands, and capture output programmatically. " +
                    "Actions: " +
                    "`open` \u2014 start a new session, returns session id. Optional `cwd`. " +
                    "`write` \u2014 send `text` (or `command`) to the session's stdin. Newline is appended automatically. Returns immediately. " +
                    "`read` \u2014 wait `wait_ms` (default 1000, max 30000), then return accumulated output and clear buffer. " +
                    "`close` \u2014 kill the session. " +
                    "`list` \u2014 list all open sessions. " +
                    "Typical flow: open \u2192 write \"npm run dev\" \u2192 read (wait 2000) \u2192 write more commands \u2192 close.",
                parameters: obj(
                    {
                        action: {
                            type: "string",
                            enum: ["open", "write", "read", "close", "list", "show", "peek"],
                            description: "What to do. 'peek' shows current buffer without clearing it.",
                        },
                        id: str("Session id (required for write/read/close/show)"),
                        cwd: str("Working directory (open action only, optional, relative to workspace)"),
                        text: str("Text/command to send to stdin (write action). Newline appended automatically."),
                        command: str("Alias for `text` (write action)"),
                        wait_ms: num("How long to wait before returning output, default 1000, max 30000 (read action only)"),
                        clear: { type: "boolean", description: "Clear buffer after read? Default true (read action only)" },
                        show: { type: "boolean", description: "Show the terminal panel after opening? Default true (open action only)" },
                    },
                    ["action"]
                ),
            },
        },
        run: async (a: any) => {
            const action = String(a.action || "");
            try {
                if (action === "open") {
                    if (!(await askToolApproval("terminal", `Open shell session${a.cwd ? " in " + a.cwd : ""}?`))) {
                        return "User denied terminal session";
                    }
                    const s = openSession({
                        cwd: a.cwd ? String(a.cwd) : undefined,
                        show: a.show !== false,
                    });
                    return `Opened session ${s.id}\nShell: ${s.shell}\nCwd: ${s.cwd}`;
                }
                if (action === "show") {
                    if (!a.id) return "Error: id is required for show";
                    const ok = showSession(String(a.id));
                    return ok ? `Revealed ${a.id}` : `Session ${a.id} not found`;
                }
                if (action === "write") {
                    if (!a.id) return "Error: id is required for write";
                    const text = a.text != null ? String(a.text) : (a.command != null ? String(a.command) : "");
                    if (!text) return "Error: text or command is required for write";
                    if (!(await askToolApproval("terminal", `Send to ${a.id}: ${text.slice(0, 80)}`))) {
                        return "User denied terminal write";
                    }
                    writeToSession(String(a.id), text);
                    return `Wrote ${text.length} chars to ${a.id}`;
                }
                if (action === "read") {
                    if (!a.id) return "Error: id is required for read";
                    const waitMs = a.wait_ms != null ? Number(a.wait_ms) : 1000;
                    const clear = a.clear !== false;
                    const r = await readFromSession(String(a.id), { waitMs, clear });
                    const head = `Session ${a.id}${r.closed ? ` (closed, exit ${r.exitCode})` : ""} \u2014 ${r.output.length} bytes\n---`;
                    let body = r.output.length ? `${head}\n${r.output}` : `${head}\n(no new output)`;
                    if (r.userInputSinceLastRead) {
                        body += `\n\n[USER TYPED in terminal since last read]:\n${r.userInputSinceLastRead}`;
                    }
                    return body;
                }
                if (action === "peek") {
                    if (!a.id) return "Error: id is required for peek";
                    const p = peekSession(String(a.id));
                    if (!p) return `Session ${a.id} not found`;
                    let body = `Session ${a.id}${p.closed ? ` (closed, exit ${p.exitCode})` : " (running)"} \u2014 buffer ${p.output.length} bytes (not cleared)\n---\n${p.output || "(empty)"}`;
                    if (p.userInputBuffer) {
                        body += `\n\n[USER TYPED in terminal]:\n${p.userInputBuffer}`;
                    }
                    return body;
                }
                if (action === "close") {
                    if (!a.id) return "Error: id is required for close";
                    const ok = closeSession(String(a.id));
                    return ok ? `Closed ${a.id}` : `Session ${a.id} not found`;
                }
                if (action === "list") {
                    const arr = listSessions();
                    if (!arr.length) return "(no open sessions)";
                    return arr.map((s) => {
                        const uTag = s.userInputChars > 0 ? `  user-typed=${s.userInputChars}ch` : "";
                        return `${s.id}  ${s.shell}  cwd=${s.cwd}  ${s.closed ? `closed(exit ${s.exitCode})` : "running"}  buf=${s.bufferBytes}b  age=${Math.round(s.ageMs / 1000)}s${uTag}`;
                    }).join("\n");
                }
                return `Error: unknown action "${action}". Use open/write/read/close/list/show/peek.`;
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "open_in_browser",
                description:
                    "Open a local file or URL in the default browser using the correct OS command.",
                parameters: obj(
                    {
                        target: str("File path (workspace-relative) or URL"),
                    },
                    ["target"]
                ),
            },
        },
        run: async ({ target }: { target: string }) => {
            const isUrl = /^https?:\/\//i.test(target);
            if (isUrl) {
                await vscode.env.openExternal(vscode.Uri.parse(target));
                return `Opened URL: ${target}`;
            }
            const uri = resolve(target);
            await vscode.env.openExternal(uri);
            return `Opened: ${target}`;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "list_tasks",
                description: "List VS Code tasks declared in tasks.json.",
                parameters: obj({}),
            },
        },
        run: async () => {
            const tasks = await listTasks();
            return tasks.length
                ? tasks.map((t) => `${t.name} [${t.source}]`).join("\n")
                : "(no tasks)";
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "run_task",
                description: "Run a VS Code task by name.",
                parameters: obj({ name: str("Task name") }, ["name"]),
            },
        },
        run: async ({ name }: { name: string }) => {
            if (!(await askToolApproval("run_task", `Run task "${name}"?`)))
                return "User denied task";
            return runTaskByName(name);
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "git_status",
                description: "git status --short --branch",
                parameters: obj({}),
            },
        },
        run: async () => gitStatus(),
    },

    {
        def: {
            type: "function",
            function: {
                name: "git_diff",
                description:
                    "git diff for the workspace, optionally a single path.",
                parameters: obj({ path: str("Optional") }),
            },
        },
        run: async ({ path }: { path?: string }) => gitDiff(path),
    },

    {
        def: {
            type: "function",
            function: {
                name: "workspace_info",
                description: "Workspace folders, active file, language.",
                parameters: obj({}),
            },
        },
        run: async () => {
            const folders = (vscode.workspace.workspaceFolders ?? []).map(
                (f) => f.uri.fsPath
            );
            const ed = vscode.window.activeTextEditor;
            return JSON.stringify(
                {
                    folders,
                    activeFile: ed ? toRel(ed.document.uri) : null,
                    language: ed?.document.languageId ?? null,
                    lineCount: ed?.document.lineCount ?? null,
                },
                null,
                2
            );
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "system_info",
                description:
                    "Get host OS, shell, VS Code and workspace context.",
                parameters: obj({}),
            },
        },
        run: async () => JSON.stringify(systemInfo(), null, 2),
    },

    {
        def: {
            type: "function",
            function: {
                name: "read_project_context",
                description:
                    "Read the persistent project context file (.onlysq/context.md). " +
                    "This file holds long-lived notes about the project: stack, structure, conventions, decisions. " +
                    "It is auto-injected into the agent system prompt at the start of each run. " +
                    "Returns null if the file does not exist yet.",
                parameters: obj({}),
            },
        },
        run: async () => {
            const text = await readProjectContext();
            if (text === null)
                return `(${projectContextPath()} does not exist yet — use update_project_context to create it)`;
            return text;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "update_project_context",
                description:
                    "Create or fully overwrite the persistent project context file (.onlysq/context.md). " +
                    "Use this to record durable knowledge about the project: tech stack, important paths, build/test commands, coding conventions, ongoing decisions. " +
                    "Goes through the normal Apply/Reject diff flow. Keep it concise (under ~6KB) — it is injected into every agent run.",
                parameters: obj(
                    {
                        content: str("Full new content of the context file (markdown)."),
                        reason: str("Short summary of what changed and why"),
                    },
                    ["content"]
                ),
            },
        },
        run: async (a: any, ctx) => {
            const proposal = await createProposal({
                id: ctx.callId,
                path: projectContextPath(),
                newContent: String(a.content ?? ""),
                reason: a.reason
                    ? String(a.reason)
                    : "Update project context",
            });
            return finalizeEditProposal(
                proposal.id,
                projectContextPath(),
                a.reason ? String(a.reason) : undefined,
                "Project context update",
                "update_project_context"
            );
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "get_my_config",
                description:
                    "Return the agent's own runtime configuration: extension version, current chat model, " +
                    "approval policies, agent limits, registered tool names, whether project context exists. " +
                    "Use this for self-introspection.",
                parameters: obj({}),
            },
        },
        run: async () => {
            const cfg = settings();
            const ext = vscode.extensions.getExtension(
                "subashev.onlysq-cli"
            );
            const version =
                (ext?.packageJSON as any)?.version ?? "unknown";
            const hasCtx = await hasProjectContext();
            return JSON.stringify(
                {
                    extensionVersion: version,
                    chatModel: cfg.chatModel,
                    completionModel: cfg.completionModel,
                    temperature: cfg.temperature,
                    maxAgentSteps: cfg.maxAgentSteps,
                    parallelTools: cfg.parallelTools,
                    toolCache: cfg.toolCache,
                    toolPolicy: cfg.toolPolicy,
                    projectContext: {
                        path: projectContextPath(),
                        exists: hasCtx,
                    },
                },
                null,
                2
            );
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "run_vscode_command",
                description:
                    'Run any VS Code command by id (e.g. "editor.action.formatDocument").',
                parameters: obj(
                    {
                        command: str("VS Code command id"),
                        args: arr({}, "Optional args"),
                    },
                    ["command"]
                ),
            },
        },
        run: async ({ command, args }: { command: string; args?: any[] }) => {
            if (
                !(await askToolApproval(
                    "run_vscode_command",
                    `Run VS Code command "${command}"?`
                ))
            ) {
                return "User denied command";
            }
            const r = await vscode.commands.executeCommand(
                command,
                ...(args ?? [])
            );
            try {
                return JSON.stringify(r ?? null);
            } catch {
                return String(r);
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "fetch_url",
                description:
                    "Fetch a URL and return the response. Useful for APIs, documentation pages, raw files. " +
                    "Returns status, content-type, and body (max 100KB).",
                parameters: obj(
                    {
                        url: str("URL to fetch"),
                        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: 'Default GET' },
                        headers: { type: "object", description: "Optional request headers", additionalProperties: { type: "string" } },
                    },
                    ["url"]
                ),
            },
        },
        run: async (a: any) => {
            if (!(await askToolApproval("fetch_url", `Fetch ${a.url}?`)))
                return "User denied web request";
            try {
                const r = await fetchUrl(String(a.url), {
                    method: a.method,
                    headers: a.headers,
                });
                let out = `HTTP ${r.status} (${r.contentType})\n`;
                if (r.truncated) out += "(truncated to 100KB)\n";
                out += "---\n" + r.body;
                return out;
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "web_search",
                description:
                    "Search the web and return top results with titles, URLs, and snippets. " +
                    "Uses DuckDuckGo. Good for finding documentation, packages, solutions.",
                parameters: obj(
                    {
                        query: str("Search query"),
                        max_results: num("Max results, default 5"),
                    },
                    ["query"]
                ),
            },
        },
        run: async (a: any) => {
            if (!(await askToolApproval("web_search", `Web search: ${a.query}?`)))
                return "User denied web search";
            try {
                return await webSearch(String(a.query), a.max_results ?? 5);
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "scrape_page",
                description:
                    "Download a web page and extract its text content (strips HTML tags, scripts, styles). " +
                    "Use for reading documentation, articles, READMEs on the web.",
                parameters: obj(
                    { url: str("URL to scrape") },
                    ["url"]
                ),
            },
        },
        run: async (a: any) => {
            if (!(await askToolApproval("scrape_page", `Scrape ${a.url}?`)))
                return "User denied scraping";
            try {
                return await scrapePage(String(a.url));
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "git_commit",
                description:
                    "Stage changes and create a git commit with the given message. " +
                    "Optionally specify files to stage (default: all changes).",
                parameters: obj(
                    {
                        message: str("Commit message"),
                        files: arr(str(""), "Optional list of file paths to stage. If empty, stages all changes."),
                    },
                    ["message"]
                ),
            },
        },
        run: async (a: any) => {
            if (!(await askToolApproval("git_commit", `Git commit: ${a.message}?`)))
                return "User denied commit";
            try {
                const { executeShell, formatShellResult } = await import("../../services/workspace/shell");
                const files = Array.isArray(a.files) && a.files.length
                    ? a.files.map((f: any) => `"${String(f)}"`).join(" ")
                    : ".";
                const addResult = await executeShell(`git add ${files}`, { timeoutMs: 10_000 });
                if (addResult.code !== 0) return `git add failed:\n${formatShellResult(addResult)}`;
                const commitResult = await executeShell(
                    `git commit -m "${String(a.message).replace(/"/g, '\\"')}"`,
                    { timeoutMs: 10_000 }
                );
                return formatShellResult(commitResult);
            } catch (e: any) {
                return `Error: ${e?.message ?? e}`;
            }
        },
    },

    {
        def: { type: "function", function: {
            name: "create_task",
            description: "Create a task for yourself to track progress. Returns the task ID.",
            parameters: obj({ text: str("Task description"), status: { type: "string", enum: ["todo", "in_progress", "done"], description: "Initial status, default todo" } }, ["text"]),
        }},
        run: async (a: any) => {
            const id = "task-" + (++taskCounter);
            agentTasks.push({ id, text: String(a.text), status: a.status || "todo" });
            emitTasksChange();
            return `Created task ${id}: ${a.text}`;
        },
    },
    {
        def: { type: "function", function: {
            name: "update_task",
            description: "Update the status of a task.",
            parameters: obj({ id: str("Task ID"), status: { type: "string", enum: ["todo", "in_progress", "done"], description: "New status" } }, ["id", "status"]),
        }},
        run: async (a: any) => {
            const t = agentTasks.find(t => t.id === String(a.id));
            if (!t) return `Task ${a.id} not found.`;
            t.status = a.status;
            emitTasksChange();
            return `Updated ${t.id}: ${t.status}`;
        },
    },
    {
        def: { type: "function", function: {
            name: "delete_task",
            description: "Delete a completed or unnecessary task.",
            parameters: obj({ id: str("Task ID to delete") }, ["id"]),
        }},
        run: async (a: any) => {
            const idx = agentTasks.findIndex(t => t.id === String(a.id));
            if (idx < 0) return `Task ${a.id} not found.`;
            agentTasks.splice(idx, 1);
            emitTasksChange();
            return `Deleted task ${a.id}.`;
        },
    },
    {
        def: { type: "function", function: {
            name: "list_agent_tasks",
            description: "List all your current tasks with their status.",
            parameters: obj({}),
        }},
        run: async () => {
            if (!agentTasks.length) return "(no tasks)";
            return agentTasks.map(t => `[${t.status}] ${t.id}: ${t.text}`).join("\n");
        },
    },

    {
        def: { type: "function", function: {
            name: "add_memory",
            description: "Store a persistent key-value pair in agent memory. Use to remember user preferences, project context, decisions, etc. Survives between sessions.",
            parameters: obj({ key: str("Memory key (short label)"), value: str("Value to store") }, ["key", "value"]),
        }},
        run: async (a: any) => {
            if (!_memoryStore) return "Error: memory store not initialized";
            await _memoryStore.set(String(a.key), String(a.value));
            return `Stored: ${a.key} = ${String(a.value).slice(0, 100)}`;
        },
    },
    {
        def: { type: "function", function: {
            name: "get_memory",
            description: "Retrieve a value from agent memory by key.",
            parameters: obj({ key: str("Memory key to look up") }, ["key"]),
        }},
        run: async (a: any) => {
            if (!_memoryStore) return "Error: memory store not initialized";
            const v = _memoryStore.get(String(a.key));
            return v !== undefined ? `${a.key} = ${v}` : `Key "${a.key}" not found in memory.`;
        },
    },
    {
        def: { type: "function", function: {
            name: "view_memories",
            description: "List all stored memories, optionally filtered by a search query.",
            parameters: obj({ query: str("Optional search filter") }),
        }},
        run: async (a: any) => {
            if (!_memoryStore) return "Error: memory store not initialized";
            const entries = a.query ? _memoryStore.search(String(a.query)) : _memoryStore.list();
            if (!entries.length) return "(no memories stored)";
            return entries.map((e: any) => `${e.key}: ${e.value}`).join("\n");
        },
    },
    {
        def: { type: "function", function: {
            name: "delete_memory",
            description: "Delete a memory entry by key.",
            parameters: obj({ key: str("Key to delete") }, ["key"]),
        }},
        run: async (a: any) => {
            if (!_memoryStore) return "Error: memory store not initialized";
            const ok = await _memoryStore.delete(String(a.key));
            return ok ? `Deleted: ${a.key}` : `Key "${a.key}" not found.`;
        },
    },

    {
        def: {
            type: "function",
            function: {
                name: "delegate",
                description:
                    "Delegate a task to a specialized sub-agent. Available sub-agents:\n" +
                    Object.entries(SUBAGENTS)
                        .map(([k, v]) => `  - ${k}: ${v.description}`)
                        .join("\n") +
                    "\nThe sub-agent runs in its own context with limited tools, does NOT see your conversation history, and returns a text result. " +
                    "Use this when a task is well-defined and can be solved independently.",
                parameters: obj(
                    {
                        agent: {
                            type: "string",
                            enum: Object.keys(SUBAGENTS),
                            description: "Which sub-agent to use",
                        },
                        goal: str(
                            "Clear, self-contained task description for the sub-agent. Include all context it needs — it cannot see your history."
                        ),
                    },
                    ["agent", "goal"]
                ),
            },
        },
        run: async (a: any, _ctx) => {
            const def = SUBAGENTS[a.agent];
            if (!def)
                return `Error: unknown sub-agent "${a.agent}". Available: ${Object.keys(SUBAGENTS).join(", ")}`;
            return (
                "__DELEGATE__:" + a.agent + ":" + String(a.goal ?? "")
            );
        },
    },
];
