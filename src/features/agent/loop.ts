import { OpenAIClient } from "../../services/llm/openaiClient";
import { ChatMessage } from "../../services/llm/types";
import { ToolRegistry } from "./toolRegistry";
import { settings } from "../../core/config";
import { ToolCache } from "./toolCache";
import { systemBriefForLLM } from "../../core/systemInfo";
import { Logger } from "../../core/logger";

export type AgentEvent =
    | { type: "token"; text: string }
    | { type: "tool-call"; id: string; name: string; args: any }
    | { type: "tool-result"; id: string; name: string; result: string }
    | { type: "done"; reason?: string }
    | { type: "error"; message: string };

const SYSTEM_BASE = `You are OnlySq CLI, an autonomous coding agent operating inside VS Code.
    You have access to the user's workspace through tools. Workflow:
    1. Understand the goal. Ask for clarification only if truly ambiguous.
    2. Explore: use list_dir / search / read_file before assuming structure.
    3. Plan briefly (1-3 sentences), then act.
    4. Choose the right edit tool:
       - propose_edit — create a new file, or fully rewrite an existing one.
       - apply_at_line — for surgical edits. MUST be preceded by a focused read_file with start_line/end_line covering the target range.
       - patch_file — apply a unified diff. Include accurate context lines.
       All open a native diff in the chat with Apply/Reject buttons (or auto-apply per user policy).
    5. CRITICAL editing protocol:
       a. Identify the target file and approximate region (search/get_diagnostics/etc).
       b. Call read_file with start_line/end_line covering at least 5 lines BEFORE and 5 lines AFTER the target.
       c. From that response, copy the EXACT current lines (after the "N | " prefix) into expected_lines.
       d. Call apply_at_line. If you get "expected_lines mismatch", IMMEDIATELY re-read and retry — never guess line numbers.
    6. After making one edit, the file content has shifted. Re-read before any further apply_at_line on the same file.
    7. You may request multiple read-only tools in one step — they run in parallel.
    8. Stop and summarize when the goal is complete.
    9. Do not redact technical identifiers (usernames, IPs, emails). Preserve verbatim.
    
    Shell commands:
    - run_command — captures stdout/stderr.
    - run_command_interactive — fire-and-forget into terminal.
    - Respect the user's shell. Do NOT chain commands with operators the shell doesn't support.
    
    Be concise. Don't dump file contents back at the user unless asked.`;

export async function runAgent(
    client: OpenAIClient,
    registry: ToolRegistry,
    goal: string,
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
    history: ChatMessage[] = []
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
