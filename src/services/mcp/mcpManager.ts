import * as vscode from "vscode";
import * as path from "path";
import { McpServer, McpServerConfig, McpServerState } from "./mcpClient";
import { ToolRegistry, ToolHandler } from "../../features/agent/toolRegistry";
import { Logger } from "../../core/logger";
import { resolve, readText, writeText, exists } from "../workspace/fs";

const CONFIG_PATH = ".onlysq/mcp.json";
const TOOL_PREFIX = "mcp__";

interface McpConfigFile {
    servers?: Record<string, McpServerConfig>;
    mcpServers?: Record<string, McpServerConfig>;
}

export interface McpManagerEvent {
    type: "state-change";
}

export class McpManager {
    private servers = new Map<string, McpServer>();
    private readonly _onChange = new vscode.EventEmitter<McpManagerEvent>();
    readonly onChange = this._onChange.event;

    constructor(private registry: ToolRegistry) {}

    states(): McpServerState[] {
        return [...this.servers.values()].map((s) => s.state());
    }

    private buildToolName(serverName: string, toolName: string): string {
        const safeServer = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
        return `${TOOL_PREFIX}${safeServer}__${safeTool}`;
    }

    async loadConfig(): Promise<McpConfigFile> {
        try {
            if (!(await exists(CONFIG_PATH))) {
                Logger.log(`[mcp] no config at ${CONFIG_PATH}`);
                return {};
            }
            const raw = await readText(CONFIG_PATH);
            const parsed = JSON.parse(raw) as McpConfigFile;
            return parsed || {};
        } catch (e: any) {
            Logger.error("[mcp] config load failed", e);
            vscode.window.showWarningMessage(`OnlySq MCP: failed to parse ${CONFIG_PATH}: ${e?.message ?? e}`);
            return {};
        }
    }

    configPath(): string {
        const ws = vscode.workspace.workspaceFolders?.[0];
        return ws ? path.join(ws.uri.fsPath, CONFIG_PATH) : CONFIG_PATH;
    }

    async ensureConfigExists(): Promise<string> {
        const p = this.configPath();
        if (!(await exists(CONFIG_PATH))) {
            const sample: McpConfigFile = {
                servers: {
                    "example-filesystem": {
                        command: "npx",
                        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
                        disabled: true,
                    },
                },
            };
            await writeText(CONFIG_PATH, JSON.stringify(sample, null, 2));
            Logger.log(`[mcp] created sample config at ${p}`);
        }
        return p;
    }

    private async writeServersMap(map: Record<string, McpServerConfig>): Promise<void> {
        const out: McpConfigFile = { servers: map };
        await writeText(CONFIG_PATH, JSON.stringify(out, null, 2));
    }

    private async currentServersMap(): Promise<Record<string, McpServerConfig>> {
        const cfg = await this.loadConfig();
        const map = cfg.servers || cfg.mcpServers || {};
        return { ...map };
    }

    async addServer(name: string, config: McpServerConfig): Promise<{ ok: boolean; error?: string }> {
        const trimmed = name.trim();
        if (!trimmed) return { ok: false, error: "name is empty" };
        if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return { ok: false, error: "name must match [a-zA-Z0-9_-]+" };
        if (!config.command || !config.command.trim()) return { ok: false, error: "command is empty" };
        const map = await this.currentServersMap();
        if (map[trimmed]) return { ok: false, error: `server '${trimmed}' already exists` };
        map[trimmed] = config;
        await this.writeServersMap(map);
        await this.startOne(trimmed, config);
        this._onChange.fire({ type: "state-change" });
        return { ok: true };
    }

    async removeServer(name: string): Promise<boolean> {
        const map = await this.currentServersMap();
        if (!(name in map)) return false;
        delete map[name];
        await this.writeServersMap(map);
        await this.stopOne(name);
        this._onChange.fire({ type: "state-change" });
        return true;
    }

    async toggleServer(name: string): Promise<boolean> {
        const map = await this.currentServersMap();
        if (!(name in map)) return false;
        map[name].disabled = !map[name].disabled;
        await this.writeServersMap(map);
        if (map[name].disabled) {
            await this.stopOne(name);
            const srv = new McpServer(name, map[name]);
            this.servers.set(name, srv);
        } else {
            await this.stopOne(name);
            await this.startOne(name, map[name]);
        }
        this._onChange.fire({ type: "state-change" });
        return true;
    }

    async restartOne(name: string): Promise<boolean> {
        const map = await this.currentServersMap();
        if (!(name in map)) return false;
        await this.stopOne(name);
        await this.startOne(name, map[name]);
        this._onChange.fire({ type: "state-change" });
        return true;
    }

    private async startOne(name: string, srvCfg: McpServerConfig): Promise<void> {
        const srv = new McpServer(name, srvCfg);
        this.servers.set(name, srv);
        await srv.connect();
        if (srv.status === "ready") {
            this.registerServerTools(srv);
        }
    }

    private async stopOne(name: string): Promise<void> {
        const srv = this.servers.get(name);
        if (!srv) return;
        const prefix = `${TOOL_PREFIX}${name.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
        const removed = this.registry.unregisterPrefix(prefix);
        if (removed.length) Logger.log(`[mcp] ${name} unregistered ${removed.length} tool(s)`);
        await srv.dispose();
        this.servers.delete(name);
    }

    async start(): Promise<void> {
        await this.stopAll();
        const cfg = await this.loadConfig();
        const map = cfg.servers || cfg.mcpServers || {};
        const entries = Object.entries(map);
        if (!entries.length) {
            Logger.log("[mcp] no servers configured");
            this._onChange.fire({ type: "state-change" });
            return;
        }
        Logger.log(`[mcp] starting ${entries.length} server(s)`);
        await Promise.all(
            entries.map(async ([name, srvCfg]) => {
                const srv = new McpServer(name, srvCfg);
                this.servers.set(name, srv);
                await srv.connect();
                if (srv.status === "ready") {
                    this.registerServerTools(srv);
                }
            })
        );
        this._onChange.fire({ type: "state-change" });
    }

    async restart(): Promise<void> {
        await this.start();
    }

    private registerServerTools(srv: McpServer): void {
        for (const tool of srv.tools) {
            const fullName = this.buildToolName(srv.name, tool.name);
            const handler: ToolHandler = {
                def: {
                    type: "function",
                    function: {
                        name: fullName,
                        description: `[MCP:${srv.name}] ${tool.description || tool.name}`,
                        parameters: tool.inputSchema || { type: "object", properties: {} },
                    },
                },
                run: async (args: any) => {
                    try {
                        return await srv.callTool(tool.name, args);
                    } catch (e: any) {
                        return `Error: ${e?.message ?? e}`;
                    }
                },
            };
            this.registry.register(handler);
            Logger.log(`[mcp] registered ${fullName}`);
        }
    }

    async stopAll(): Promise<void> {
        const removed = this.registry.unregisterPrefix(TOOL_PREFIX);
        if (removed.length) {
            Logger.log(`[mcp] unregistered ${removed.length} tool(s)`);
        }
        await Promise.all([...this.servers.values()].map((s) => s.dispose()));
        this.servers.clear();
    }

    async dispose(): Promise<void> {
        await this.stopAll();
        this._onChange.dispose();
    }
}
