import * as vscode from "vscode";

const STORAGE_KEY = "onlysq.memory";
const MAX_ENTRIES = 200;
const MAX_VALUE_LEN = 10_000;

export interface MemoryEntry {
    key: string;
    value: string;
}

export class MemoryStore {
    private data: Record<string, string>;
    private readonly _onChange = new vscode.EventEmitter<MemoryEntry[]>();
    readonly onChange = this._onChange.event;

    constructor(private ctx: vscode.ExtensionContext) {
        const raw = ctx.workspaceState.get<Record<string, string>>(STORAGE_KEY);
        this.data = raw && typeof raw === "object" ? { ...raw } : {};
    }

    get(key: string): string | undefined {
        return this.data[key];
    }

    list(): MemoryEntry[] {
        return Object.entries(this.data).map(([key, value]) => ({ key, value }));
    }

    search(query: string): MemoryEntry[] {
        const q = query.toLowerCase();
        return this.list().filter(
            (e) =>
                e.key.toLowerCase().includes(q) ||
                e.value.toLowerCase().includes(q)
        );
    }

    async set(key: string, value: string): Promise<void> {
        if (!key.trim()) throw new Error("Key cannot be empty");
        const val = value.slice(0, MAX_VALUE_LEN);
        this.data[key.trim()] = val;
        const keys = Object.keys(this.data);
        if (keys.length > MAX_ENTRIES) {
            delete this.data[keys[0]];
        }
        await this.persist();
        this.emitChange();
    }

    async rename(oldKey: string, newKey: string): Promise<boolean> {
        const trimmed = newKey.trim();
        if (!trimmed) return false;
        if (!(oldKey in this.data)) return false;
        if (trimmed === oldKey) return true;
        if (trimmed in this.data) return false;
        const value = this.data[oldKey];
        const entries = Object.entries(this.data);
        this.data = {};
        for (const [k, v] of entries) {
            if (k === oldKey) this.data[trimmed] = value;
            else this.data[k] = v;
        }
        await this.persist();
        this.emitChange();
        return true;
    }

    async delete(key: string): Promise<boolean> {
        if (!(key in this.data)) return false;
        delete this.data[key];
        await this.persist();
        this.emitChange();
        return true;
    }

    async clear(): Promise<void> {
        this.data = {};
        await this.persist();
        this.emitChange();
    }

    count(): number {
        return Object.keys(this.data).length;
    }

    /** Dump all memories as context string for system prompt */
    toContext(): string {
        const entries = this.list();
        if (!entries.length) return "";
        const lines = entries.map((e) => `- ${e.key}: ${e.value}`);
        return `\n\n--- Agent Memory (${entries.length} entries) ---\n${lines.join("\n")}`;
    }

    private async persist(): Promise<void> {
        await this.ctx.workspaceState.update(STORAGE_KEY, this.data);
    }

    private emitChange(): void {
        this._onChange.fire(this.list());
    }
}
