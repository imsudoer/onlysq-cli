import * as vscode from "vscode";
import { Logger } from "./core/logger";
import { DisposableStore } from "./core/disposable";
import { settings, updateSetting } from "./core/config";
import { CredentialStore } from "./services/auth/storage";
import { UsageTracker } from "./services/llm/usageTracker";
import { AuthService } from "./services/auth/authService";
import { OpenAIClient } from "./services/llm/openaiClient";
import { ModelsService } from "./services/llm/modelsService";
import { ToolRegistry } from "./features/agent/toolRegistry";
import { builtinTools, setMemoryStore, initAgentTasksStore } from "./features/agent/tools";
import { MemoryStore } from "./services/memory/memoryStore";
import { OnlySqInlineProvider } from "./features/completion/provider";
import { ChatView } from "./ui/chatView";
import { StatusBar } from "./ui/statusBar";
import { registerDiffProvider } from "./services/workspace/diffPreview";
import { disposeTerminal } from "./services/workspace/terminal";
import { disposeAllSessions } from "./services/workspace/terminalSession";
import {
    hasProjectContext,
    projectContextPath,
} from "./services/workspace/projectContext";
import { McpManager } from "./services/mcp/mcpManager";

export async function activate(ctx: vscode.ExtensionContext) {
    Logger.init("OnlySq CLI");
    Logger.log("Activating OnlySq CLI");

    const store = new CredentialStore(ctx);
    const auth = new AuthService(store);
    await auth.init();

    const modelsService = new ModelsService(ctx, auth);

    const memory = new MemoryStore(ctx);

    const registry = new ToolRegistry();
    registry.registerAll(builtinTools);
    setMemoryStore(memory);
    initAgentTasksStore(ctx.workspaceState);

    const mcp = new McpManager(registry);
    ctx.subscriptions.push({ dispose: () => { void mcp.dispose(); } });
    void mcp.start().catch((e) => Logger.error("[mcp] start failed", e));

    // Hot reload on config change
    const mcpWatcher = vscode.workspace.createFileSystemWatcher("**/.onlysq/mcp.json");
    let mcpReloadTimer: NodeJS.Timeout | undefined;
    const scheduleMcpReload = () => {
        if (mcpReloadTimer) clearTimeout(mcpReloadTimer);
        mcpReloadTimer = setTimeout(() => {
            Logger.log("[mcp] config changed, reloading");
            void mcp.restart();
        }, 500);
    };
    mcpWatcher.onDidChange(scheduleMcpReload);
    mcpWatcher.onDidCreate(scheduleMcpReload);
    mcpWatcher.onDidDelete(scheduleMcpReload);
    ctx.subscriptions.push(mcpWatcher);

    registerDiffProvider(ctx);

    const usage = new UsageTracker(ctx);
    const client = new OpenAIClient(auth, usage);
    const chat = new ChatView(ctx, client, registry, auth, modelsService, memory, mcp);

    const status = new StatusBar(auth, usage);

    const subs = new DisposableStore();
    ctx.subscriptions.push(subs, status);

    subs.add(
        vscode.window.registerWebviewViewProvider(ChatView.viewId, chat, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    let inlineDisposable: vscode.Disposable | undefined;
    const registerInline = () => {
        inlineDisposable?.dispose();
        inlineDisposable = undefined;
        if (settings().inlineEnabled) {
            inlineDisposable =
                vscode.languages.registerInlineCompletionItemProvider(
                    { pattern: "**" },
                    new OnlySqInlineProvider(client)
                );
            subs.add(inlineDisposable);
        }
    };
    registerInline();
    subs.add(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration("onlysq.inlineCompletions.enabled") ||
                e.affectsConfiguration("onlysq.completionModel")
            ) {
                registerInline();
            }
        })
    );

    const cmd = (id: string, fn: (...a: any[]) => any) =>
        subs.add(vscode.commands.registerCommand(id, fn));

    cmd("onlysq.signIn", () => auth.signIn());
    cmd("onlysq.signOut", () => auth.signOut());
    cmd("onlysq.openChat", () => chat.focus());
    cmd("onlysq.showLog", () => Logger.show());

    cmd("onlysq.explainSelection", async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed) return;
        const text = ed.selection.isEmpty
            ? ed.document.getText()
            : ed.document.getText(ed.selection);
        if (!text.trim()) return;
        await chat.sendPrompt("Explain this code:", "chat");
    });

    cmd("onlysq.refactorSelection", async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed || ed.selection.isEmpty) {
            vscode.window.showWarningMessage("OnlySq: select code first");
            return;
        }
        await chat.sendPrompt(
            "Refactor the selected code. Use propose_edit to apply changes.",
            "agent"
        );
    });

    cmd("onlysq.openSettings", () => {
        chat.focus();
        chat.openSettingsPanel();
    });

    cmd("onlysq.runAgent", async () => {
        const goal = await vscode.window.showInputBox({
            prompt: "What should OnlySq agent do?",
            placeHolder: "e.g. Add unit tests for src/utils.ts",
        });
        if (!goal) return;
        await chat.sendPrompt(goal, "agent");
    });

    cmd("onlysq.selectModel", async () => {
        const list = await modelsService.fetch();
        if (!list.length) {
            vscode.window.showWarningMessage("OnlySq: no models available");
            return;
        }
        const groups = modelsService.groupByOwner(list);
        const items: vscode.QuickPickItem[] = [];
        for (const owner of Object.keys(groups).sort()) {
            items.push({
                label: owner,
                kind: vscode.QuickPickItemKind.Separator,
            });
            for (const m of groups[owner]) {
                items.push({ label: m.id, description: owner });
            }
        }
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: `Current: ${settings().chatModel}`,
            matchOnDescription: true,
        });
        if (pick?.label) await updateSetting("chatModel", pick.label);
    });

    cmd("onlysq.selectCompletionModel", async () => {
        const list = await modelsService.fetch();
        if (!list.length) {
            vscode.window.showWarningMessage("OnlySq: no models available");
            return;
        }
        const groups = modelsService.groupByOwner(list);
        const items: vscode.QuickPickItem[] = [];
        for (const owner of Object.keys(groups).sort()) {
            items.push({
                label: owner,
                kind: vscode.QuickPickItemKind.Separator,
            });
            for (const m of groups[owner]) {
                items.push({ label: m.id, description: owner });
            }
        }
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: `Current completion model: ${
                settings().completionModel
            }`,
            matchOnDescription: true,
        });
        if (pick?.label) await updateSetting("completionModel", pick.label);
    });

    cmd("onlysq.initProjectContext", async () => {
        if (await hasProjectContext()) {
            const pick = await vscode.window.showWarningMessage(
                `${projectContextPath()} already exists. Regenerate it?`,
                { modal: true },
                "Regenerate",
                "Cancel"
            );
            if (pick !== "Regenerate") return;
        }
        const goal =
            `Initialize the project context file at ${projectContextPath()}. ` +
            `Explore the workspace (list_tree, read key files like package.json / README / main entry points), ` +
            `then call update_project_context with a concise markdown summary covering: ` +
            `tech stack and frameworks, project structure (key folders / files), ` +
            `build / test / run commands, coding conventions visible in the code, ` +
            `any non-obvious decisions or gotchas. Keep it under ~4KB. Do not duplicate the README verbatim.`;
        await chat.sendPrompt(goal, "agent");
    });

    cmd("onlysq.resetUsage", () => usage.reset());
    cmd("onlysq.newChat", async () => {
        chat.focus();
        await chat.newChat();
    });

    cmd("onlysq.mcp.reload", async () => {
        vscode.window.showInformationMessage("OnlySq MCP: reloading servers\u2026");
        await mcp.restart();
        const states = mcp.states();
        const ok = states.filter((s) => s.status === "ready").length;
        const err = states.filter((s) => s.status === "error").length;
        const total = states.length;
        vscode.window.showInformationMessage(`OnlySq MCP: ${ok}/${total} ready${err ? `, ${err} failed` : ""}`);
    });

    cmd("onlysq.mcp.editConfig", async () => {
        const p = await mcp.ensureConfigExists();
        const doc = await vscode.workspace.openTextDocument(p);
        await vscode.window.showTextDocument(doc);
    });

    cmd("onlysq.mcp.status", () => {
        const states = mcp.states();
        if (!states.length) {
            vscode.window.showInformationMessage("OnlySq MCP: no servers configured. Run 'OnlySq: MCP \u2014 Edit Config' to add one.");
            return;
        }
        const lines = states.map((s) => {
            const tools = s.toolCount > 0 ? ` \u2014 ${s.toolCount} tool(s)` : "";
            const err = s.error ? ` (${s.error.slice(0, 80)})` : "";
            return `\u2022 ${s.name}: ${s.status}${tools}${err}`;
        });
        Logger.log("[mcp] status:\n" + lines.join("\n"));
        Logger.show();
        vscode.window.showInformationMessage(`MCP: ${lines.length} server(s). See log for details.`);
    });

    if (await auth.isSignedIn()) {
        void modelsService.fetch().catch(() => {});
    }

    Logger.log("Activated");
}

export function deactivate(): void {
    disposeTerminal();
    disposeAllSessions();
    Logger.log("Deactivated");
}
