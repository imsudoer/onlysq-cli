import { AI } from "../../core/config";
import { AuthService } from "../auth/authService";
import { Logger } from "../../core/logger";

export interface EmbeddingsRequest {
    model: string;
    input: string[];
}

export interface EmbeddingsResponse {
    model: string;
    data: Array<{ index: number; embedding: number[] }>;
    usage?: { prompt_tokens: number; total_tokens: number };
}

export class EmbeddingsClient {
    constructor(private auth: AuthService) {}

    async embed(
        req: EmbeddingsRequest,
        signal?: AbortSignal
    ): Promise<EmbeddingsResponse> {
        if (!req.input || !req.input.length) {
            return { model: req.model, data: [] };
        }
        Logger.log(
            `[embed] model=${req.model} batch=${req.input.length} totalChars=${req.input.reduce((a, b) => a + b.length, 0)}`
        );
        let key = await this.auth.getApiKey();
        let resp = await this.send(key, req, signal);
        if (resp.status === 401) {
            Logger.log("[embed] 401, refreshing api key");
            key = await this.auth.getApiKey(true);
            resp = await this.send(key, req, signal);
        }
        if (!resp.ok) {
            const text = await resp.text();
            Logger.log(`[embed] ERROR ${resp.status}: ${text.slice(0, 500)}`);
            throw new Error(`Embeddings failed (${resp.status}): ${text.slice(0, 200)}`);
        }
        const json = (await resp.json()) as any;
        if (!json || !Array.isArray(json.data)) {
            throw new Error("Embeddings response: missing data array");
        }
        return {
            model: json.model || req.model,
            data: json.data.map((d: any) => ({
                index: typeof d.index === "number" ? d.index : 0,
                embedding: Array.isArray(d.embedding) ? d.embedding : [],
            })),
            usage: json.usage,
        };
    }

    private send(
        apiKey: string,
        req: EmbeddingsRequest,
        signal?: AbortSignal
    ): Promise<Response> {
        return fetch(`${AI.apiBase}${AI.embeddingsPath}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(req),
            signal,
        });
    }
}

export function cosineSim(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;
    let dot = 0;
    let aLen = 0;
    let bLen = 0;
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        aLen += a[i] * a[i];
        bLen += b[i] * b[i];
    }
    const denom = Math.sqrt(aLen) * Math.sqrt(bLen);
    return denom > 0 ? dot / denom : 0;
}
