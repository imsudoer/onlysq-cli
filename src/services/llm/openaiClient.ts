import { AI } from "../../core/config";
import { parseSSE } from "../../core/sse";
import { AuthService } from "../auth/authService";
import { Logger } from "../../core/logger";
import { ChatRequest, ChatDelta, ToolCall } from "./types";
import { UsageTracker } from "./usageTracker";

export class OpenAIClient {
    constructor(private auth: AuthService, private usage?: UsageTracker) {}

    async *stream(
        req: ChatRequest,
        signal?: AbortSignal
    ): AsyncGenerator<ChatDelta> {
        Logger.log(
            `[ai] stream model=${req.model} messages=${
                req.messages.length
            } tools=${req.tools?.length ?? 0}`
        );

        let key = await this.auth.getApiKey();
        let resp = await this.send(key, req, signal);
        if (resp.status === 401) {
            Logger.log("[ai] 401, refreshing api key");
            key = await this.auth.getApiKey(true);
            resp = await this.send(key, req, signal);
        }
        Logger.log(`[ai] response status=${resp.status} ok=${resp.ok}`);

        if (!resp.ok || !resp.body) {
            const text = await resp.text();
            Logger.log(`[ai] ERROR body: ${text.slice(0, 1000)}`);
            throw new Error(`Chat failed (${resp.status}): ${text}`);
        }

        const ctype = (resp.headers.get("content-type") ?? "").toLowerCase();
        Logger.log(`[ai] content-type: ${ctype}`);

        if (!ctype.includes("text/event-stream")) {
            const text = await resp.text();
            Logger.log(
                `[ai] non-SSE body (${text.length}ch): ${text.slice(0, 2000)}`
            );

            let parsed: any;
            try {
                parsed = JSON.parse(text);
            } catch {
                /* not json */
            }

            if (parsed?.error) {
                const msg =
                    parsed.error?.message ?? JSON.stringify(parsed.error);
                throw new Error(`Provider error: ${msg}`);
            }
            if (parsed?.choices?.[0]?.message) {
                const m = parsed.choices[0].message;
                const out: ChatDelta = {};
                if (m.content) out.content = m.content;
                if (m.tool_calls) out.toolCalls = m.tool_calls;
                if (parsed.choices[0].finish_reason)
                    out.finishReason = parsed.choices[0].finish_reason;
                if (parsed.usage) this.usage?.record(parsed.usage);
                yield out;
                return;
            }

            const stripped = text
                .replace(/<[^>]+>/g, "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 500);
            throw new Error(
                `Provider returned ${ctype} instead of stream: ${
                    stripped || "(empty)"
                }`
            );
        }

        const acc: Record<number, ToolCall> = {};
        let chunks = 0;
        let contentBytes = 0;
        let toolBytes = 0;
        let lastFinish: string | undefined;

        for await (const chunk of parseSSE(resp.body)) {
            chunks++;
            if (chunks <= 3)
                Logger.log(
                    `[ai] chunk #${chunks}: ${JSON.stringify(chunk).slice(
                        0,
                        400
                    )}`
                );
            if (chunk?.error) {
                Logger.log(
                    `[ai] mid-stream error: ${JSON.stringify(chunk.error)}`
                );
                throw new Error(
                    `Provider error: ${JSON.stringify(chunk.error)}`
                );
            }
            if (chunk?.usage) this.usage?.record(chunk.usage);
            const choice = chunk?.choices?.[0];
            const delta = choice?.delta;
            if (!delta) continue;

            const out: ChatDelta = {};
            if (delta.content) {
                out.content = delta.content;
                contentBytes += delta.content.length;
            }
            if (delta.tool_calls) {
                out.toolCalls = mergeToolCalls(acc, delta.tool_calls);
                for (const tc of delta.tool_calls)
                    toolBytes += tc?.function?.arguments?.length ?? 0;
            }
            if (choice.finish_reason) {
                out.finishReason = choice.finish_reason;
                lastFinish = choice.finish_reason;
            }
            yield out;
        }
        Logger.log(
            `[ai] stream end. chunks=${chunks}, content=${contentBytes}ch, tool_args=${toolBytes}ch, finish=${lastFinish}`
        );

        if (chunks === 0) {
            throw new Error("Provider returned empty SSE stream");
        }
    }

    async complete(req: ChatRequest, signal?: AbortSignal): Promise<string> {
        let out = "";
        for await (const d of this.stream(req, signal))
            if (d.content) out += d.content;
        return out;
    }

    private send(
        apiKey: string,
        req: ChatRequest,
        signal?: AbortSignal
    ): Promise<Response> {
        return fetch(`${AI.apiBase}${AI.chatPath}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                ...req,
                stream: true,
                stream_options: { include_usage: true },
            }),
            signal,
        });
    }
}

function mergeToolCalls(
    acc: Record<number, ToolCall>,
    parts: any[]
): ToolCall[] {
    for (const p of parts) {
        const i = p.index ?? 0;
        acc[i] ??= {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
        };
        if (p.id) acc[i].id = p.id;
        if (p.function?.name) acc[i].function.name += p.function.name;
        if (p.function?.arguments)
            acc[i].function.arguments += p.function.arguments;
    }
    return Object.values(acc);
}
