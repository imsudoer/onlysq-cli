import { ToolDef } from "../../services/llm/types";

export interface ToolContext {
    callId: string;
}

export interface ToolHandler {
    def: ToolDef;
    run(args: any, ctx: ToolContext): Promise<string>;
}

export class ToolRegistry {
    private tools = new Map<string, ToolHandler>();

    register(t: ToolHandler): void {
        this.tools.set(t.def.function.name, t);
    }
    registerAll(ts: ToolHandler[]): void {
        for (const t of ts) this.register(t);
    }
    list(): ToolDef[] {
        return [...this.tools.values()].map((t) => t.def);
    }
    get(name: string): ToolHandler | undefined {
        return this.tools.get(name);
    }
    unregister(name: string): boolean {
        return this.tools.delete(name);
    }
    unregisterPrefix(prefix: string): string[] {
        const removed: string[] = [];
        for (const name of [...this.tools.keys()]) {
            if (name.startsWith(prefix)) {
                this.tools.delete(name);
                removed.push(name);
            }
        }
        return removed;
    }
    has(name: string): boolean {
        return this.tools.has(name);
    }
}
