import * as vscode from "vscode";
import { AI, STORAGE_KEYS } from "../../core/config";
import { AuthService } from "../auth/authService";
import { Logger } from "../../core/logger";

const CACHE_TTL_MS = 60 * 60 * 1000;

export interface ModelInfo {
    id: string;
    owner: string;
}

interface CachedModels {
    fetchedAt: number;
    list: ModelInfo[];
}

const PROVIDER_LABELS: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    gemini: "Google",
    cohere: "Cohere",
    deepseek: "DeepSeek",
    grok: "xAI",
    qwen: "Qwen",
    perplexity: "Perplexity",
    mistral: "Mistral",
    cloudflare: "Cloudflare",
    salutedevices: "GigaChat",
    websim: "Websim",
    "zai-org": "Z.AI",
};

export function providerOf(owner: string): string {
    const k = String(owner).toLowerCase().replace(/[<>]/g, "").trim();
    return PROVIDER_LABELS[k] ?? (owner || "Other");
}

export class ModelsService {
    private readonly _onChange = new vscode.EventEmitter<ModelInfo[]>();
    readonly onChange = this._onChange.event;

    constructor(
        private ctx: vscode.ExtensionContext,
        private auth: AuthService
    ) {}

    private readCache(): CachedModels | null {
        const raw = this.ctx.globalState.get<any>(STORAGE_KEYS.models);
        if (!raw) return null;
        if (Array.isArray(raw)) {
            return { fetchedAt: 0, list: raw };
        }
        if (raw && Array.isArray(raw.list)) {
            return { fetchedAt: Number(raw.fetchedAt) || 0, list: raw.list };
        }
        return null;
    }

    cached(): ModelInfo[] {
        return this.readCache()?.list ?? [];
    }

    isStale(): boolean {
        const c = this.readCache();
        if (!c || !c.list.length) return true;
        return Date.now() - c.fetchedAt > CACHE_TTL_MS;
    }

    async fetch(force = false): Promise<ModelInfo[]> {
        const cache = this.readCache();
        const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
        if (!force && fresh) return cache.list;
        if (!force && cache?.list.length && this.isStale()) {
            void this.refreshInBackground();
            return cache.list;
        }
        return this.refreshNow();
    }

    private async refreshInBackground(): Promise<void> {
        try {
            await this.refreshNow();
        } catch (e) {
            Logger.error("[models] background refresh", e);
        }
    }

    private async refreshNow(): Promise<ModelInfo[]> {
        Logger.log("[models] fetching from API");
        const key = await this.auth.getApiKey();
        const r = await fetch(`${AI.apiBase}${AI.modelsPath}`, {
            headers: { Authorization: `Bearer ${key}` },
        });
        if (!r.ok) {
            const body = await r.text();
            throw new Error(
                `models fetch failed (${r.status}): ${body.slice(0, 300)}`
            );
        }
        const body = (await r.json()) as {
            data?: Array<{ id: string; owned_by?: string }>;
        };
        const list = (body.data ?? [])
            .filter((m) => !!m?.id)
            .map((m) => ({
                id: m.id,
                owner: providerOf(m.owned_by ?? "Other"),
            }))
            .sort((a, b) =>
                a.owner === b.owner
                    ? a.id.localeCompare(b.id)
                    : a.owner.localeCompare(b.owner)
            );

        const next: CachedModels = { fetchedAt: Date.now(), list };
        await this.ctx.globalState.update(STORAGE_KEYS.models, next);
        Logger.log(`[models] cached ${list.length} models`);
        this._onChange.fire(list);
        return list;
    }

    groupByOwner(models: ModelInfo[]): Record<string, ModelInfo[]> {
        const out: Record<string, ModelInfo[]> = {};
        for (const m of models) (out[m.owner] ??= []).push(m);
        return out;
    }
}
