import * as vscode from "vscode";

const STORAGE_KEY = "onlysq.memory";
const MAX_ENTRIES = 200;
const MAX_VALUE_LEN = 10_000;

export class MemoryStore {
    private data: Record<string, string>;

    constructor(private ctx: vscode.ExtensionContext) {
        const raw = ctx.workspaceState.get<Record<string, string>>(STORAGE_KEY);
        this.data = raw && typeof raw === "object" ? { ...raw } : {};
    }

    get(key: string): string | undefined {
        return this.data[key];
    }

    list(): Array<{ key: string; value: string }> {
        return Object.entries(this.data).map(([key, value]) => ({ key, value }));
    }

    search(query: string): Array<{ key: string; value: string }> {
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
        // Enforce max entries
        const keys = Object.keys(this.data);
        if (keys.length > MAX_ENTRIES) {
            delete this.data[keys[0]];
        }
        await this.persist();
    }

    async delete(key: string): Promise<boolean> {
        if (!(key in this.data)) return false;
        delete this.data[key];
        await this.persist();
        return true;
    }

    async clear(): Promise<void> {
        this.data = {};
        await this.persist();
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
}
