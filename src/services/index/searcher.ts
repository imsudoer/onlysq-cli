import { EmbeddingsClient, cosineSim } from "../llm/embeddingsClient";
import { Logger } from "../../core/logger";
import { WorkspaceIndexer, IndexFile } from "./indexer";

export interface SearchHit {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
}

export class SemanticSearcher {
    private cache?: IndexFile;
    private cacheLoadedAt = 0;

    constructor(private indexer: WorkspaceIndexer, private embeddings: EmbeddingsClient) {}

    async invalidate(): Promise<void> {
        this.cache = undefined;
    }

    private async getIndex(): Promise<IndexFile | null> {
        const now = Date.now();
        if (this.cache && now - this.cacheLoadedAt < 10_000) return this.cache;
        const idx = await this.indexer.loadIndex();
        if (idx) {
            this.cache = idx;
            this.cacheLoadedAt = now;
        }
        return idx;
    }

    async search(
        query: string,
        opts: { topK?: number; pathFilter?: string; signal?: AbortSignal } = {}
    ): Promise<{ hits: SearchHit[]; indexStats: { files: number; chunks: number; model: string } | null }> {
        const idx = await this.getIndex();
        if (!idx) {
            Logger.log("[search] no index loaded");
            return { hits: [], indexStats: null };
        }
        if (!query.trim()) return { hits: [], indexStats: this.statsOf(idx) };

        const topK = Math.max(1, Math.min(opts.topK ?? 8, 50));
        Logger.log(`[search] q="${query.slice(0, 80)}" topK=${topK} model=${idx.model}`);

        const qResp = await this.embeddings.embed({ model: idx.model, input: [query] }, opts.signal);
        const qVec = qResp.data[0]?.embedding;
        if (!qVec || !qVec.length) {
            Logger.error("[search] empty query embedding", new Error("no embedding returned"));
            return { hits: [], indexStats: this.statsOf(idx) };
        }

        const filter = opts.pathFilter?.toLowerCase();
        const scored: SearchHit[] = [];
        for (const [path, entry] of Object.entries(idx.files)) {
            if (filter && !path.toLowerCase().includes(filter)) continue;
            for (const ch of entry.chunks) {
                if (!ch.embedding || !ch.embedding.length) continue;
                const score = cosineSim(qVec, ch.embedding);
                if (score <= 0) continue;
                scored.push({
                    path,
                    startLine: ch.startLine,
                    endLine: ch.endLine,
                    score,
                    snippet: ch.text.slice(0, 240).replace(/\s+/g, " ").trim(),
                });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return { hits: scored.slice(0, topK), indexStats: this.statsOf(idx) };
    }

    private statsOf(idx: IndexFile): { files: number; chunks: number; model: string } {
        let chunks = 0;
        for (const f of Object.values(idx.files)) chunks += f.chunks.length;
        return { files: Object.keys(idx.files).length, chunks, model: idx.model };
    }
}
