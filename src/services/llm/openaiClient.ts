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

        try {
            const approxPromptText = JSON.stringify(req.messages) + (req.tools ? JSON.stringify(req.tools) : "");
            this.usage?.previewAddPrompt(approxPromptText);
        } catch {}

        let key = await this.auth.getApiKey();
        let resp: Response | undefined;
        let lastErr: any;
        const MAX_ATTEMPTS = 3;
        const RETRY_DELAY = 5000;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                resp = await this.send(key, req, signal);
                if (resp.status === 401 && attempt === 1) {
                    Logger.log("[ai] 401, refreshing api key");
                    key = await this.auth.getApiKey(true);
                    resp = await this.send(key, req, signal);
                }
                Logger.log(`[ai] response status=${resp.status} ok=${resp.ok} (attempt ${attempt}/${MAX_ATTEMPTS})`);
                if (resp.ok) break;
                if (resp.status < 500 && resp.status !== 429) break;
                if (attempt < MAX_ATTEMPTS) {
                    Logger.log(`[ai] retryable ${resp.status}, waiting ${RETRY_DELAY}ms before retry`);
                    try { await sleepWithSignal(RETRY_DELAY, signal); } catch { throw new Error("cancelled"); }
                }
            } catch (e: any) {
                lastErr = e;
                if (signal?.aborted || /aborted|cancelled/i.test(String(e?.message))) throw e;
                Logger.log(`[ai] fetch threw on attempt ${attempt}/${MAX_ATTEMPTS}: ${e?.message ?? e}`);
                if (attempt < MAX_ATTEMPTS) {
                    try { await sleepWithSignal(RETRY_DELAY, signal); } catch { throw new Error("cancelled"); }
                } else {
                    throw e;
                }
            }
        }
        if (!resp) throw lastErr ?? new Error("Chat failed: no response");

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
                this.usage?.previewAddCompletion(delta.content);
            }
            if (delta.tool_calls) {
                out.toolCalls = mergeToolCalls(acc, delta.tool_calls);
                for (const tc of delta.tool_calls) {
                    const argLen = tc?.function?.arguments?.length ?? 0;
                    toolBytes += argLen;
                    if (argLen) this.usage?.previewAddCompletion(tc.function.arguments);
                }
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

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new Error("aborted")); return; }
        const t = setTimeout(() => {
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() { clearTimeout(t); reject(new Error("aborted")); }
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
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
