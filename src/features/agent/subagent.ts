import { OpenAIClient } from "../../services/llm/openaiClient";
import { ChatMessage, ToolDef } from "../../services/llm/types";
import { ToolRegistry } from "./toolRegistry";
import { ToolCache } from "./toolCache";
import { settings } from "../../core/config";
import { Logger } from "../../core/logger";
import { AgentEvent, AgentControl } from "./loop";

export interface SubAgentDef {
    name: string;
    description: string;
    systemPrompt: string;
    allowedTools: string[];
    maxSteps?: number;
    model?: string;
}

export async function runSubAgent(
    def: SubAgentDef,
    client: OpenAIClient,
    fullRegistry: ToolRegistry,
    goal: string,
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
    control?: AgentControl
): Promise<string> {
    const cfg = settings();
    const model = def.model ?? cfg.chatModel;
    const maxSteps = def.maxSteps ?? Math.min(cfg.maxAgentSteps, 30);
    const cache = new ToolCache(cfg.toolCache);

    const tools: ToolDef[] = [];
    for (const name of def.allowedTools) {
        const t = fullRegistry.get(name);
        if (t) tools.push(t.def);
    }

    const messages: ChatMessage[] = [
        { role: "system", content: def.systemPrompt },
        { role: "user", content: goal },
    ];

    Logger.log(
        `[subagent:${def.name}] start, model=${model}, tools=${tools.length}, max=${maxSteps}`
    );

    let lastContent = "";

    for (let step = 0; step < maxSteps; step++) {
        if (signal?.aborted) return "(cancelled)";

        if (control?.shouldPause()) {
            await control.waitIfPaused?.(`Sub-agent ${def.name} paused`);
        }

        let content = "";
        let toolCalls: any[] = [];

        try {
            for await (const d of client.stream(
                {
                    model,
                    temperature: cfg.temperature,
                    messages,
                    tools: tools.length ? tools : undefined,
                    tool_choice: tools.length ? "auto" : undefined,
                    max_tokens: 4096,
                },
                signal
            )) {
                if (d.content) {
                    content += d.content;
                    onEvent({ type: "token", text: d.content });
                }
                if (d.toolCalls) toolCalls = d.toolCalls;
            }
        } catch (e: any) {
            Logger.error(`[subagent:${def.name}] error`, e);
            return `Error in sub-agent ${def.name}: ${e?.message ?? e}`;
        }

        messages.push({
            role: "assistant",
            content,
            tool_calls: toolCalls.length ? toolCalls : undefined,
        });
        lastContent = content;

        if (!toolCalls.length) break;

        for (const tc of toolCalls) {
            let args: any = {};
            try {
                args = JSON.parse(tc.function.arguments || "{}");
            } catch {
                /* */
            }

            onEvent({
                type: "tool-call",
                id: tc.id,
                name: tc.function.name,
                args,
            });

            const cached = cache.get(tc.function.name, args);
            if (cached !== undefined) {
                onEvent({
                    type: "tool-result",
                    id: tc.id,
                    name: tc.function.name,
                    result: "(cached) " + cached,
                });
                messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: cached,
                });
                continue;
            }

            const tool = fullRegistry.get(tc.function.name);
            let result: string;
            try {
                result =
                    tool && def.allowedTools.includes(tc.function.name)
                        ? await tool.run(args, { callId: tc.id })
                        : `Tool ${tc.function.name} is not available in this context`;
            } catch (e: any) {
                result = `Error: ${e?.message ?? e}`;
            }

            cache.set(tc.function.name, args, result);
            onEvent({
                type: "tool-result",
                id: tc.id,
                name: tc.function.name,
                result,
            });
            messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result.slice(0, 60_000),
            });
        }
    }

    Logger.log(
        `[subagent:${def.name}] done, result=${lastContent.length}ch`
    );
    return lastContent || "(sub-agent returned empty result)";
}
