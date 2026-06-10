import * as vscode from "vscode";
import { STORAGE_KEYS } from "../../core/config";

export interface UsageSnapshot {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requests: number;
    sessionStartedAt: number;
}

const EMPTY: UsageSnapshot = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
    sessionStartedAt: Date.now(),
};

export class UsageTracker {
    private snap: UsageSnapshot;
    private preview = { prompt: 0, completion: 0 };
    private readonly _onChange = new vscode.EventEmitter<UsageSnapshot>();
    readonly onChange = this._onChange.event;

    constructor(private ctx: vscode.ExtensionContext) {
        const stored = ctx.workspaceState.get<UsageSnapshot>(STORAGE_KEYS.sessionUsage);
        this.snap = stored && Date.now() - stored.sessionStartedAt < 24 * 3600_000
            ? stored
            : { ...EMPTY, sessionStartedAt: Date.now() };
    }

    get current(): UsageSnapshot {
        return {
            ...this.snap,
            promptTokens: this.snap.promptTokens + this.preview.prompt,
            completionTokens: this.snap.completionTokens + this.preview.completion,
            totalTokens: this.snap.totalTokens + this.preview.prompt + this.preview.completion,
        };
    }

    previewAddCompletion(text: string): void {
        if (!text) return;
        this.preview.completion += Math.max(1, Math.round(text.length / 4));
        this._onChange.fire(this.current);
    }

    previewAddPrompt(text: string): void {
        if (!text) return;
        this.preview.prompt += Math.max(1, Math.round(text.length / 4));
        this._onChange.fire(this.current);
    }

    record(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined | null): void {
        if (!usage) return;
        this.snap.promptTokens += usage.prompt_tokens ?? 0;
        this.snap.completionTokens += usage.completion_tokens ?? 0;
        this.snap.totalTokens += usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
        this.snap.requests++;
        this.preview.prompt = 0;
        this.preview.completion = 0;
        void this.ctx.workspaceState.update(STORAGE_KEYS.sessionUsage, this.snap);
        this._onChange.fire(this.current);
    }

    reset(): void {
        this.snap = { ...EMPTY, sessionStartedAt: Date.now() };
        this.preview = { prompt: 0, completion: 0 };
        void this.ctx.workspaceState.update(STORAGE_KEYS.sessionUsage, this.snap);
        this._onChange.fire(this.current);
    }
}
