import { OpenAIClient } from "../../services/llm/openaiClient";
import { ChatMessage } from "../../services/llm/types";
import { ToolRegistry } from "./toolRegistry";
import { settings } from "../../core/config";
import { ToolCache } from "./toolCache";
import { systemBriefForLLM } from "../../core/systemInfo";
import { Logger } from "../../core/logger";
import { SUBAGENTS } from "./subagentDefs";

export type AgentEvent =
    | { type: "token"; text: string }
    | { type: "tool-call"; id: string; name: string; args: any }
    | { type: "tool-result"; id: string; name: string; result: string }
    | { type: "ask-user"; id: string; question: string; options?: string[]; multiSelect: boolean }
    | { type: "pause"; reason?: string }
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
   - replace_in_file — most reliable for targeted edits. Quote the EXACT current text in "find" (with proper indentation), provide the new text in "replace". Use multi-line strings as needed.
   - apply_at_line — when you need to operate by line numbers (rare).
   - patch_file — apply a unified diff (advanced).
   All open a native diff in the chat with Apply/Reject buttons (or auto-apply per user policy).
    5. CRITICAL editing protocol:
   a. Identify the target file (search/get_diagnostics/etc).
   b. Call read_file (with start_line/end_line for big files) to see exact current content.
   c. For most edits, use replace_in_file: quote the exact current text in "find" (preserving indentation, whitespace, line breaks). Multiple ops in one call are applied sequentially.
   d. If you get "not found" — the file content differs from what you assume. Re-read and copy the text precisely.
   e. After making one edit, the file content has shifted. Re-read before any further edit on the same file.
    6. After making one edit, the file content has shifted. Re-read before any further apply_at_line on the same file.
    7. You may request multiple read-only tools in one step — they run in parallel.
    8. Stop and summarize when the goal is complete.
    9. If you need the user to review before continuing, call pause_agent with a clear reason.
    10. If you need clarification, confirmation, or a choice from the user, call ask_user. Provide options when applicable.
    11. Do not redact technical identifiers (usernames, IPs, emails). Preserve verbatim.
    
    Shell commands:
    - run_command — captures stdout/stderr.
    - run_command_interactive — fire-and-forget into terminal.
    - Respect the user's shell. Do NOT chain commands with operators the shell doesn't support.
    
    12. For complex tasks, use delegate() to hand off well-defined subtasks to specialized sub-agents:
    - code_reviewer: find bugs and security issues (read-only)
    - code_writer: implement changes
    - test_runner: run and fix tests
    - explorer: understand codebase structure (read-only)
    - shell_operator: system/DevOps tasks
    - refactorer: restructure code preserving behavior
    - doc_writer: write documentation
    - planner: break complex goals into steps (read-only)
    Sub-agents work in isolation — include all necessary context in the goal.
    
    Be concise. Don't dump file contents back at the user unless asked.`;

export async function runAgent(
    client: OpenAIClient,
    registry: ToolRegistry,
    goal: string,
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
    history: ChatMessage[] = [],
    control?: AgentControl,
): Promise<ChatMessage[]> {
    const cfg = settings();
    const cache = new ToolCache(cfg.toolCache);

    const systemPrompt = `${SYSTEM_BASE}\n\n--- System context ---\n${systemBriefForLLM()}`;

    const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: goal },
    ];
    const tools = registry.list();

    Logger.log(
        `[agent] starting run, history=${history.length}, tools=${tools.length}, max_steps=${cfg.maxAgentSteps}`
    );

    for (let step = 0; step < cfg.maxAgentSteps; step++) {
        if (control?.shouldPause()) {
            Logger.log("[agent] pause before next step");
            onEvent({ type: "pause", reason: "Paused before next step" });
            await control.waitIfPaused("Paused before next step");
        }

        if (signal?.aborted) {
            Logger.log("[agent] aborted by signal");
            onEvent({ type: "done", reason: "cancelled" });
            return messages;
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
                if (d.toolCalls) toolCalls = d.toolCalls;
                if (d.finishReason) finishReason = d.finishReason;
            }
        } catch (e: any) {
            Logger.error("[agent] stream error", e);
            onEvent({ type: "error", message: String(e?.message ?? e) });
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

            const tool = registry.get(tc.function.name);
            let result: string;
            try {
                result = tool
                    ? await tool.run(args, { callId: tc.id })
                    : `Unknown tool: ${tc.function.name}`;
            } catch (e: any) {
                result = `Error: ${e?.message ?? e}`;
                Logger.error(`[agent] tool ${tc.function.name} threw`, e);
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

        for (const r of results) {
            messages.push({
                role: "tool",
                tool_call_id: r.id,
                content: r.result.slice(0, 60_000),
            });
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
