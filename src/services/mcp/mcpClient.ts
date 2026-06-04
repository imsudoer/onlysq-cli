import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Logger } from "../../core/logger";

export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    disabled?: boolean;
}

export interface McpServerState {
    name: string;
    status: "connecting" | "ready" | "error" | "disabled";
    error?: string;
    toolCount: number;
    toolNames: string[];
    command: string;
    args: string[];
    disabled: boolean;
    tools: Array<{ name: string; description: string }>;
}

export interface McpToolInfo {
    serverName: string;
    name: string;
    description: string;
    inputSchema: any;
}

export class McpServer {
    readonly name: string;
    readonly config: McpServerConfig;
    private client?: Client;
    private transport?: StdioClientTransport;
    private _tools: McpToolInfo[] = [];
    private _status: McpServerState["status"] = "connecting";
    private _error?: string;

    constructor(name: string, config: McpServerConfig) {
        this.name = name;
        this.config = config;
    }

    get status(): McpServerState["status"] {
        return this._status;
    }

    get tools(): McpToolInfo[] {
        return this._tools;
    }

    state(): McpServerState {
        return {
            name: this.name,
            status: this._status,
            error: this._error,
            toolCount: this._tools.length,
            toolNames: this._tools.map((t) => t.name),
            command: this.config.command,
            args: this.config.args ?? [],
            disabled: !!this.config.disabled,
            tools: this._tools.map((t) => ({ name: t.name, description: t.description })),
        };
    }

    async connect(): Promise<void> {
        if (this.config.disabled) {
            this._status = "disabled";
            return;
        }
        try {
            this.transport = new StdioClientTransport({
                command: this.config.command,
                args: this.config.args ?? [],
                env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
                cwd: this.config.cwd,
            });
            this.client = new Client(
                { name: "onlysq-cli", version: "0.1.0" },
                { capabilities: {} }
            );
            await this.client.connect(this.transport);
            Logger.log(`[mcp] ${this.name} connected, listing tools...`);

            const res = await this.client.listTools();
            this._tools = (res.tools || []).map((t: any) => ({
                serverName: this.name,
                name: t.name,
                description: t.description || "",
                inputSchema: t.inputSchema || { type: "object", properties: {} },
            }));
            this._status = "ready";
            Logger.log(`[mcp] ${this.name} ready, ${this._tools.length} tool(s): ${this._tools.map((t) => t.name).join(", ")}`);
        } catch (e: any) {
            this._status = "error";
            this._error = String(e?.message ?? e);
            Logger.error(`[mcp] ${this.name} failed to connect`, e);
        }
    }

    async callTool(name: string, args: any): Promise<string> {
        if (!this.client || this._status !== "ready") {
            throw new Error(`Server ${this.name} not ready (${this._status})`);
        }
        const res = await this.client.callTool({ name, arguments: args ?? {} });
        return formatMcpResult(res);
    }

    async dispose(): Promise<void> {
        try {
            await this.client?.close();
        } catch (e) {
            Logger.error(`[mcp] ${this.name} close error`, e);
        }
        this.client = undefined;
        this.transport = undefined;
        this._tools = [];
        this._status = "disabled";
    }
}

function formatMcpResult(res: any): string {
    if (!res) return "(empty)";
    const parts: string[] = [];
    const content = Array.isArray(res.content) ? res.content : [];
    for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") {
            parts.push(c.text);
        } else if (c?.type === "image") {
            parts.push(`[image ${c.mimeType ?? ""} ${c.data ? "(" + Math.round(String(c.data).length / 1024) + "KB)" : ""}]`);
        } else if (c?.type === "resource" && c.resource) {
            parts.push(`[resource ${c.resource.uri ?? ""}]`);
            if (typeof c.resource.text === "string") parts.push(c.resource.text);
        } else {
            try { parts.push(JSON.stringify(c)); } catch { /* ignore */ }
        }
    }
    if (res.isError) {
        return "Error: " + (parts.join("\n") || "tool returned isError without content");
    }
    return parts.join("\n") || "(empty)";
}
