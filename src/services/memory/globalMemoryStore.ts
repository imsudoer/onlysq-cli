import * as vscode from "vscode";

const STORAGE_KEY = "onlysq.globalMemory";
const MAX_ENTRIES = 500;
const MAX_VALUE_LEN = 10_000;

export interface GlobalMemoryEntry {
    key: string;
    value: string;
    updatedAt: number;
}

export class GlobalMemoryStore {
    private data: Record<string, { value: string; updatedAt: number }>;
    private readonly _onChange = new vscode.EventEmitter<GlobalMemoryEntry[]>();
    readonly onChange = this._onChange.event;

    constructor(private ctx: vscode.ExtensionContext) {
        const raw = ctx.globalState.get<Record<string, any>>(STORAGE_KEY);
        this.data = {};
        if (raw && typeof raw === "object") {
            for (const [k, v] of Object.entries(raw)) {
                if (typeof v === "string") this.data[k] = { value: v, updatedAt: Date.now() };
                else if (v && typeof v === "object" && typeof v.value === "string") {
                    this.data[k] = { value: v.value, updatedAt: Number(v.updatedAt) || Date.now() };
                }
            }
        }
    }

    get(key: string): string | undefined {
        return this.data[key]?.value;
    }

    list(): GlobalMemoryEntry[] {
        return Object.entries(this.data)
            .map(([key, v]) => ({ key, value: v.value, updatedAt: v.updatedAt }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    search(q: string): GlobalMemoryEntry[] {
        const s = q.toLowerCase();
        return this.list().filter(e => e.key.toLowerCase().includes(s) || e.value.toLowerCase().includes(s));
    }

    async set(key: string, value: string): Promise<void> {
        const k = key.trim();
        if (!k) throw new Error("Key cannot be empty");
        const val = value.slice(0, MAX_VALUE_LEN);
        this.data[k] = { value: val, updatedAt: Date.now() };
        const keys = Object.keys(this.data);
        if (keys.length > MAX_ENTRIES) {
            const oldest = this.list().slice(-1)[0]?.key;
            if (oldest && oldest !== k) delete this.data[oldest];
        }
        await this.persist();
        this._onChange.fire(this.list());
    }

    async delete(key: string): Promise<boolean> {
        if (!(key in this.data)) return false;
        delete this.data[key];
        await this.persist();
        this._onChange.fire(this.list());
        return true;
    }

    async clear(): Promise<void> {
        this.data = {};
        await this.persist();
        this._onChange.fire([]);
    }

    count(): number {
        return Object.keys(this.data).length;
    }

    toContext(limit = 30): string {
        const entries = this.list().slice(0, limit);
        if (!entries.length) return "";
        const lines = entries.map(e => `- ${e.key}: ${e.value}`);
        return `\n\n--- Global Memory (cross-project, ${entries.length}/${this.count()} entries) ---\n${lines.join("\n")}`;
    }

    private async persist(): Promise<void> {
        await this.ctx.globalState.update(STORAGE_KEY, this.data);
    }
}
