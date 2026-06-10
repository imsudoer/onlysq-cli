import { OpenAIClient } from "../../services/llm/openaiClient";
import { ChatMessage } from "../../services/llm/types";
import { ToolRegistry } from "./toolRegistry";
import { settings } from "../../core/config";
import { ToolCache } from "./toolCache";
import { systemBriefForLLM } from "../../core/systemInfo";
import { Logger } from "../../core/logger";
import {
    readProjectContext,
    projectContextPath,
    truncateForPrompt,
} from "../../services/workspace/projectContext";
import { SUBAGENTS } from "./subagentDefs";
import { hasPendingEdits, waitForPendingEdits, listPendingEdits } from "../../services/workspace/diffPreview";
import { onUserInput, UserInputEvent } from "../../services/workspace/terminalSession";

const WRITE_TOOLS = new Set([
    "propose_edit",
    "apply_at_line",
    "replace_in_file",
    "patch_file",
    "update_project_context",
    "delete_file",
    "rename_file",
]);

export type AgentEvent =
    | { type: "token"; text: string }
    | { type: "tool-call"; id: string; name: string; args: any }
    | { type: "tool-call-partial"; id: string; name: string; argsPartial: string }
    | { type: "tool-result"; id: string; name: string; result: string }
    | { type: "ask-user"; id: string; question: string; options?: string[]; multiSelect: boolean }
    | { type: "pause"; reason?: string }
    | { type: "step"; step: number; maxSteps: number; tokens?: { prompt: number; completion: number; total: number } }
    | { type: "done"; reason?: string }
    | { type: "error"; message: string };

export interface AgentControl {
    shouldPause: () => boolean;
    waitIfPaused: (reason?: string) => Promise<void>;
    askUser?: (callId: string) => Promise<string>;
    getLiveMessages?: () => ChatMessage[];
}

const SYSTEM_BASE = `You are OnlySq CLI, an autonomous coding agent operating inside VS Code.
    You have access to the user's workspace through tools. Workflow:
    1. Understand the goal. Ask for clarification only if truly ambiguous.
    2. Explore: use list_dir / search / read_file before assuming structure.
    3. Plan briefly (1-3 sentences), then act.
    4. Choose the right edit tool:
   - propose_edit — create a new file, or fully rewrite an existing one.
   - replace_in_file — most reliable for targeted edits. Quote the EXACT current text in "find", provide the new text in "replace".
   - apply_at_line — operate by line numbers (rare).
   - patch_file — apply a unified diff (advanced).
    5. CRITICAL editing protocol: read_file first (so you know exact current content) → edit → re-read before next edit on the same file (content shifted).

    6. PARALLEL TOOL CALLS — IMPORTANT. The API and runtime support multiple tool_calls in ONE assistant message and they are executed in parallel (read-only) or in order (writes/shell). USE THIS:
   - When you need to read 3+ files, search and list_dir at once, gather diagnostics, look up several memory keys — emit ALL of those tool_calls in the SAME response. Do not serialize one-by-one across steps.
   - Good pattern: "I'll inspect these files and run search" → ONE message with 4 tool_calls.
   - Bad pattern: one tool_call → wait → another tool_call → wait. Wastes turns.
   - Writes (propose_edit, replace_in_file, run_command, terminal) are still run sequentially for safety, but you can still batch them in one response.
   You also see them in parallel on tool results — keep correlating by tool_call_id.

    7. Shell: run_command (captures), run_command_interactive (fires & forgets), terminal (live session). Respect user's shell — no '&&' / '||' chains on PowerShell.

    8. DELEGATE to sub-agents when a subtask is isolated (explorer for 3+ unfamiliar files, planner for plans, code_reviewer for bug hunts, refactorer for structure preservation, etc). Sub-agents have NO access to your history — pass full context in the goal.

    9. TASKS (create_task / update_task / list_agent_tasks / delete_task) — use AGGRESSIVELY, not occasionally:
   - Any goal touching 2+ files OR more than ~3 steps → create tasks BEFORE you start.
   - Mark each task in_progress when you begin it, done when truly finished (not "partially done").
   - If user adds a new request mid-run — append to tasks, do NOT drop earlier ones.
   - Periodically (every ~5 tool calls) call list_agent_tasks to make sure nothing was forgotten.
   - Tasks are persisted and visible to the user — they're your TODO board, not a luxury.

    10. MEMORY — record everything that will save context next time. There are TWO stores:
   - PROJECT memory (add_memory / get_memory / view_memories / delete_memory) — workspace-scoped: file layouts, conventions, decisions, build commands, gotchas SPECIFIC to this project.
   - GLOBAL memory (add_global_memory / get_global_memory / view_global_memories / delete_global_memory) — cross-project, follows the user across ALL workspaces. Use for: user's name & preferences, SERVER IPs / hostnames / SSH details the user mentions, common OS/env quirks, frequently-used credentials hints (NOT actual secrets), languages they work in, list of their projects.
   When the user shares ANY of: server IP, hostname, SSH user, OS, frequently-used domain, project name they jump between, important personal preference — IMMEDIATELY record it (add_global_memory for cross-project, add_memory for project-specific). Don't say "I'll remember", actually call the tool.

    11. UNCERTAINTY: if you don't know — SAY so and verify via tools (read_file, search, fetch_url, web_search). Don't invent signatures, paths, versions, error messages. A "let me check" + tool call beats a confident wrong answer.

    12. USER MESSAGES DURING YOUR WORK. If a user message arrives mid-run, it does NOT reset your task list and does NOT mean "drop what you were doing". Treat it as:
   - additional context / clarification → acknowledge in 1 line, continue the current task,
   - explicit new task → append to your task list (create_task) and finish current ones first, unless they say "stop, do this instead".
   Never silently abandon in-progress tasks. Before declaring "done", re-check list_agent_tasks — every task must be done or explicitly deleted.

    13. IMAGES. You can receive images (user pasted/dropped, or via read_image / screenshot_url tools). When a tool returns an image, the next step's user message will contain it as image_url — actually LOOK at it, don't pretend. screenshot_url needs a local Chrome/Chromium/Edge.

    14. Live terminal sharing. If a system note says "(User just typed in a live terminal...)" — read it, adjust, then continue.

    Be concise. Don't dump file contents back at the user unless asked.`;

export async function runAgent(
    client: OpenAIClient,
    registry: ToolRegistry,
    goal: string,
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
    history: ChatMessage[] = [],
    control?: AgentControl,
    extraContext?: string,
): Promise<ChatMessage[]> {
    const cfg = settings();
    const cache = new ToolCache(cfg.toolCache);

    // Cleanup orphaned pending edits from previous runs (cancelled, errored, etc)
    if (hasPendingEdits()) {
        const stale = listPendingEdits();
        Logger.log(`[agent] cleaning up ${stale.length} stale pending edit(s) from previous run: ${stale.map(p => p.path).join(", ").slice(0, 200)}`);
        const { abandonPendingEdits } = await import("../../services/workspace/diffPreview");
        abandonPendingEdits();
    }

    const pendingUserInput = new Map<string, string>();
    const unsubUserInput = onUserInput((e: UserInputEvent) => {
        const prev = pendingUserInput.get(e.sessionId) || "";
        pendingUserInput.set(e.sessionId, prev + e.data);
        Logger.log(`[agent] user typed in ${e.sessionId}: ${JSON.stringify(e.data).slice(0, 80)}`);
    });
    function drainUserInput(): string | null {
        if (!pendingUserInput.size) return null;
        const parts: string[] = [];
        for (const [sid, data] of pendingUserInput) {
            if (data) parts.push(`[user typed in terminal ${sid}]: ${data}`);
        }
        pendingUserInput.clear();
        return parts.length ? parts.join("\n") : null;
    }

    let systemPrompt = `${SYSTEM_BASE}\n\n--- System context ---\n${systemBriefForLLM()}`;
    try {
        const pctx = await readProjectContext();
        if (pctx) {
            systemPrompt +=
                `\n\n--- Project context (from ${projectContextPath()}) ---\n` +
                truncateForPrompt(pctx);
        }
    } catch (e) {
        Logger.log("[agent] failed to read project context", e);
    }
    if (cfg.customSystemPrompt) {
        systemPrompt += `\n\n--- Custom instructions ---\n${cfg.customSystemPrompt}`;
    }
    if (cfg.personalization) {
        systemPrompt += `\n\n--- Personalization ---\nLearn the user's preferences, coding style, and patterns from this conversation. Adapt your responses accordingly. Remember what they like and dislike.`;
    }
    if (extraContext) {
        systemPrompt += extraContext;
    }

    const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: goal },
    ];
    const tools = registry.list().filter(t => cfg.toolPolicy[t.function.name] !== "disabled");

    Logger.log(
        `[agent] starting run, history=${history.length}, tools=${tools.length}, max_steps=${cfg.maxAgentSteps}`
    );

    for (let step = 0; step < cfg.maxAgentSteps; step++) {
        onEvent({ type: "step", step: step + 1, maxSteps: cfg.maxAgentSteps });
        if (control?.shouldPause()) {
            Logger.log("[agent] pause before next step");
            onEvent({ type: "pause", reason: "Paused before next step" });
            await control.waitIfPaused("Paused before next step");
        }

        if (signal?.aborted) {
            Logger.log("[agent] aborted by signal");
            onEvent({ type: "done", reason: "cancelled" });
            unsubUserInput();
            return messages;
        }

        const userInputNote = drainUserInput();
        if (userInputNote) {
            Logger.log(`[agent] injecting user terminal input notice`);
            messages.push({
                role: "system",
                content: `(User just typed in a live terminal. Take this into account before the next action.)\n${userInputNote}`,
            });
        }

        Logger.log(
            `[agent] step ${step + 1}/${cfg.maxAgentSteps}, sending ${
                messages.length
            } messages`
        );

        let content = "";
        let toolCalls: any[] = [];
        let finishReason: string | undefined;

        try {
            for await (const d of client.stream(
                {
                    model: cfg.chatModel,
                    temperature: cfg.temperature,
                    messages,
                    tools,
                    tool_choice: "auto",
                },
                signal
            )) {
                if (d.content) {
                    content += d.content;
                    onEvent({ type: "token", text: d.content });
                }
                if (d.toolCalls) {
                    toolCalls = d.toolCalls;
                    // Emit partial tool preview for live display
                    for (const tc of toolCalls) {
                        if (tc.id && tc.function?.name) {
                            onEvent({
                                type: "tool-call-partial",
                                id: tc.id,
                                name: tc.function.name,
                                argsPartial: tc.function.arguments || "",
                            });
                        }
                    }
                }
                if (d.finishReason) finishReason = d.finishReason;
            }
        } catch (e: any) {
            Logger.error("[agent] stream error", e);
            onEvent({ type: "error", message: String(e?.message ?? e) });
            unsubUserInput();
            return messages;
        }

        Logger.log(
            `[agent] step ${step + 1} got: content=${
                content.length
            }ch, tool_calls=${toolCalls.length}, finish=${finishReason}`
        );

        messages.push({
            role: "assistant",
            content,
            tool_calls: toolCalls.length ? toolCalls : undefined,
        });

        if (!toolCalls.length) {
            Logger.log(
                `[agent] no tool calls, finishing. finish_reason=${finishReason}, content_length=${content.length}`
            );
            if (!content.trim() && finishReason !== "stop") {
                Logger.log(
                    "[agent] WARNING: empty response and finish_reason was",
                    finishReason
                );
            }
            onEvent({ type: "done" });
            unsubUserInput();
            return messages;
        }

        const runOne = async (
            tc: any
        ): Promise<{ id: string; name: string; result: string }> => {
            let args: any = {};
            try {
                args = JSON.parse(tc.function.arguments || "{}");
            } catch (e) {
                Logger.log(
                    "[agent] tool args parse error",
                    tc.function.arguments
                );
            }
            Logger.log(
                `[agent] -> tool ${tc.function.name}(${JSON.stringify(
                    args
                ).slice(0, 200)})`
            );
            onEvent({
                type: "tool-call",
                id: tc.id,
                name: tc.function.name,
                args,
            });

            const cached = cache.get(tc.function.name, args);
            if (cached !== undefined) {
                const cachedNote = "(cached) " + cached;
                Logger.log(
                    `[agent] <- cached ${tc.function.name} (${cachedNote.length}ch)`
                );
                onEvent({
                    type: "tool-result",
                    id: tc.id,
                    name: tc.function.name,
                    result: cachedNote,
                });
                return {
                    id: tc.id,
                    name: tc.function.name,
                    result: cachedNote,
                };
            }

            if (WRITE_TOOLS.has(tc.function.name) && hasPendingEdits()) {
                const policy = settings().toolPolicy[tc.function.name] ?? "ask";
                if (policy === "always") {
                    Logger.log(`[agent] ${tc.function.name} has policy=always, skipping wait for pending edits`);
                } else {
                    const pending = listPendingEdits();
                    Logger.log(`[agent] ${tc.function.name} waiting for ${pending.length} pending edit(s): ${pending.map(p => p.path).join(", ").slice(0, 200)}`);
                    await waitForPendingEdits(signal);
                    if (signal?.aborted) {
                        const aborted = "Error: cancelled while waiting for pending edits";
                        onEvent({ type: "tool-result", id: tc.id, name: tc.function.name, result: aborted });
                        return { id: tc.id, name: tc.function.name, result: aborted };
                    }
                }
            }

            const tool = registry.get(tc.function.name);
            let result: string;
            const { registerCancellable, unregisterCancellable } = await import("./cancelRegistry");
            let toolCancelled = false;
            const cancelPromise = new Promise<string>((resolveCancel) => {
                registerCancellable(tc.id, () => {
                    toolCancelled = true;
                    resolveCancel("Cancelled by user");
                }, tc.function.name);
            });
            try {
                if (!tool) {
                    result = `Unknown tool: ${tc.function.name}`;
                } else {
                    result = await Promise.race([
                        tool.run(args, { callId: tc.id }),
                        cancelPromise,
                    ]);
                    if (toolCancelled) {
                        result = `Cancelled by user (tool may still be running in background)`;
                        Logger.log(`[agent] tool ${tc.function.name} cancelled via race`);
                    }
                }
            } catch (e: any) {
                result = `Error: ${e?.message ?? e}`;
                Logger.error(`[agent] tool ${tc.function.name} threw`, e);
            } finally {
                unregisterCancellable(tc.id);
            }

            if (result === "__ASK_USER__" && tc.function.name === "ask_user" && control?.askUser) {
                onEvent({
                    type: "ask-user",
                    id: tc.id,
                    question: String(args.question ?? ""),
                    options: Array.isArray(args.options) ? args.options.map(String) : undefined,
                    multiSelect: !!args.multi_select,
                });
                result = await control.askUser(tc.id);
                Logger.log(`[agent] ask_user answer: ${result.slice(0, 200)}`);
            }

            if (result.startsWith("__DELEGATE__:") && tc.function.name === "delegate") {
                const parts = result.slice("__DELEGATE__:".length);
                const colonIdx = parts.indexOf(":");
                const agentName = parts.slice(0, colonIdx);
                const delegateGoal = parts.slice(colonIdx + 1);
                const subDef = SUBAGENTS[agentName];
                if (!subDef) {
                    result = `Error: unknown sub-agent "${agentName}"`;
                } else {
                    Logger.log(`[agent] delegating to ${agentName}: ${delegateGoal.slice(0, 200)}`);
                    const { runSubAgent } = await import("./subagent");
                    result = await runSubAgent(subDef, client, registry, delegateGoal, onEvent, signal, control);
                }
            }

            Logger.log(
                `[agent] <- ${tc.function.name} result (${
                    result.length
                }ch): ${result.slice(0, 200)}`
            );
            cache.set(tc.function.name, args, result);
            onEvent({
                type: "tool-result",
                id: tc.id,
                name: tc.function.name,
                result,
            });
            return { id: tc.id, name: tc.function.name, result };
        };

        const results = cfg.parallelTools
            ? await Promise.all(toolCalls.map(runOne))
            : await sequential(toolCalls, runOne);

        const pendingImages: Array<{ url: string; note: string }> = [];
        for (const r of results) {
            let content = r.result;
            const imgMarker = "__TOOL_IMAGE__\n";
            if (content.startsWith(imgMarker)) {
                try {
                    const payload = JSON.parse(content.slice(imgMarker.length));
                    if (payload && typeof payload.url === "string") {
                        pendingImages.push({ url: payload.url, note: payload.note || "image" });
                        content = payload.note || "Image attached for next step.";
                    }
                } catch {}
            }
            messages.push({
                role: "tool",
                tool_call_id: r.id,
                content: content.slice(0, 60_000),
            });
        }
        if (pendingImages.length) {
            const parts: any[] = [{ type: "text", text: `Images from tools above (${pendingImages.length}):` }];
            for (const img of pendingImages) parts.push({ type: "image_url", image_url: { url: img.url } });
            messages.push({ role: "user", content: parts });
        }

        const pauseRequested = results.some((r) => r.name === "pause_agent");
        if (pauseRequested || control?.shouldPause()) {
            const reason = pauseRequested
                ? results.find((r) => r.name === "pause_agent")?.result
                : "Paused before next step";
            Logger.log("[agent] pause after tools", reason);
            onEvent({ type: "pause", reason });
            await control?.waitIfPaused(reason);
        }

        if (signal?.aborted) {
            onEvent({ type: "done", reason: "cancelled" });
            unsubUserInput();
            return messages;
        }

        // Inject live messages from user sent during agent run
        if (control?.getLiveMessages) {
            const live = control.getLiveMessages();
            if (live.length) {
                Logger.log(`[agent] injecting ${live.length} live message(s)`);
                for (const lm of live) {
                    messages.push(lm);
                }
            }
        }
    }

    Logger.log("[agent] max_steps reached");
    onEvent({ type: "done", reason: "max_steps" });
    unsubUserInput();
    return messages;
}

async function sequential<T, R>(
    items: T[],
    fn: (x: T) => Promise<R>
): Promise<R[]> {
    const out: R[] = [];
    for (const it of items) out.push(await fn(it));
    return out;
}
