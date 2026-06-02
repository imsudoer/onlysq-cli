import * as vscode from "vscode";
import { OpenAIClient } from "../services/llm/openaiClient";
import { ChatMessage } from "../services/llm/types";
import { ToolRegistry } from "../features/agent/toolRegistry";
import { runAgent } from "../features/agent/loop";
import { AuthService, AuthState } from "../services/auth/authService";
import { ModelsService } from "../services/llm/modelsService";
import { buildHtml, nonce } from "./webview/shared";
import { Logger } from "../core/logger";
import { ChatStore, ChatSession } from "../services/chat/chatStore";
import { systemBriefForLLM } from "../core/systemInfo";
import { sanitizeHistoryForApi } from "../services/llm/historyUtils";
import { settings, updateSetting, SAUTH } from "../core/config";

const HISTORY_WINDOW = 30;
const HISTORY_PAGE = 30;

const CHAT_BODY = `
<div id="authPanel" class="auth-wrap" style="display:none">
  <div class="auth-card">
    <div class="auth-logo"><span>Sq</span><span class="dot">.</span></div>
    <div class="auth-title">OnlySq CLI</div>
    <div class="auth-sub" id="authSub">Sign in with your OnlySq account to use chat, completions and the agent.</div>
    <div class="auth-error" id="authError" style="display:none"></div>
    <button class="btn primary" id="authBtn">Auth with OnlySq</button>
  </div>
</div>

<div id="chatHeader" class="chat-header" style="display:none">
  <button class="icon-btn" id="chatsBtn" title="Chats"><svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
  <div class="chat-title-wrap">
    <span id="chatTitle" class="chat-title" title="Click to rename">New chat</span>
  </div>
  <button class="icon-btn" id="newChat" title="New chat"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
  <div style="position:relative;display:inline-block">
    <button class="icon-btn" id="exportBtn" title="Export chat"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
    <div id="exportMenu" class="export-menu">
      <button class="export-menu-item" data-format="markdown">Export as Markdown</button>
      <button class="export-menu-item" data-format="json">Export as JSON</button>
    </div>
  </div>
  <button class="icon-btn" id="settingsBtn" title="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001.08 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1.08z"/></svg></button>
</div>

<div id="chatsPanel" class="chats-panel" style="display:none">
  <div class="chats-head">
    <input type="text" id="chatsSearch" placeholder="Search chats…" />
    <button class="btn ghost small" id="chatsNewBtn">+ New</button>
  </div>
  <div id="chatsList" class="chats-list"></div>
</div>

<div id="settingsPanel" class="settings-panel" style="display:none">
  <div class="settings-head">
    <span>Settings</span>
    <button class="icon-btn" id="settingsClose" title="Close"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  </div>
  <div id="settingsBody" class="settings-body"></div>
</div>

<main id="logEl" class="chat-log" style="display:none">
  <div id="loadMoreWrap" class="load-more-wrap" style="display:none">
    <button class="btn ghost small" id="loadMoreBtn">Load previous messages</button>
  </div>
  <div id="logBody"></div>
</main>

<div id="composerWrap" class="composer-wrap" style="display:none">
  <div id="contextPins" class="context-pins"></div>
  <div id="mentionPopup" class="mention-popup"></div>
  <div id="dropOverlay" class="drop-overlay"><div class="drop-overlay-inner">Drop files here</div></div>
  <div id="attachedFiles" class="attached-files"></div>
  <div id="composer" class="composer">
    <div class="composer-resizer" id="composerResizer"></div>
    <textarea id="inp" rows="1" placeholder="Ask anything, or @ to mention a file…"></textarea>
    <div class="composer-toolbar">
      <div class="toolbar-left">
        <button class="icon-btn" id="agentToggle" title="Agent mode (file edits)"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></button>
        <div class="model-pill" id="modelPill" title="Select model">
          <span id="modelLabel">Loading…</span>
          <span class="pcaret">▾</span>
        </div>
      </div>
      <div class="toolbar-right">
        <button class="pause-btn" id="pauseBtn" title="Pause after current step" style="display:none"><svg viewBox="0 0 24 24"><line x1="10" y1="6" x2="10" y2="18"/><line x1="14" y1="6" x2="14" y2="18"/></svg></button>
        <button class="send-btn" id="sendBtn" title="Send (Enter)" disabled><svg viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
        <button class="stop-btn" id="stopBtn" title="Stop" style="display:none"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
      </div>
    </div>
  </div>
</div>

<div id="modelModal" class="modal-backdrop">
  <div class="modal">
    <div class="modal-head">
      <input id="modelSearch" type="text" placeholder="Search models…" />
    </div>
    <div id="modelList" class="modal-body"></div>
  </div>
</div>
`;

export class ChatView implements vscode.WebviewViewProvider {
    static readonly viewId = "onlysq.chat";

    private view?: vscode.WebviewView;
    private chats: ChatStore;
    private activeChat: ChatSession | null = null;
    private windowStart = 0;
    private aborter?: AbortController;
    private subs: vscode.Disposable[] = [];
    private isRunning = false;
    private paused = false;
    private pauseWaiter: (() => void) | null = null;
    private askResolvers = new Map<string, (answer: string) => void>();
    private liveMessages: import("../services/llm/types").ChatMessage[] = [];

    constructor(
        private ctx: vscode.ExtensionContext,
        private client: OpenAIClient,
        private registry: ToolRegistry,
        private auth: AuthService,
        private modelsService: ModelsService
    ) {
        this.chats = new ChatStore(ctx);
        this.activeChat = this.chats.active();
        this.windowStart = this.activeChat
            ? Math.max(0, this.activeChat.messages.length - HISTORY_WINDOW)
            : 0;
    }

    private get history(): ChatMessage[] {
        return this.activeChat?.messages ?? [];
    }

    private async persistActive(): Promise<void> {
        if (this.activeChat) {
            await this.chats.updateMessages(
                this.activeChat.id,
                this.activeChat.messages
            );
        }
    }

    private async ensureActiveChat(): Promise<ChatSession> {
        if (this.activeChat) return this.activeChat;
        this.activeChat = await this.chats.create();
        this.windowStart = 0;
        return this.activeChat;
    }

    private pushSettings(): void {
        if (!this.view) return;
        const c = vscode.workspace.getConfiguration("onlysq");
        const profile = this.auth.profile ?? {};
        this.view.webview.postMessage({
            type: "settings",
            profile: {
                name: profile.name ?? null,
                email: profile.email ?? null,
                level: profile.level ?? null,
                balance:
                    profile.balance != null
                        ? Number(profile.balance).toFixed(4)
                        : null,
                id: profile.id ?? null,
            },
            values: {
                chatModel: c.get("chatModel", "gpt-4o-mini"),
                completionModel: c.get("completionModel", "gpt-4o-mini"),
                "inlineCompletions.enabled": c.get(
                    "inlineCompletions.enabled",
                    true
                ),
                temperature: c.get("temperature", 0.3),
                "agent.maxSteps": c.get("agent.maxSteps", 50),
                "agent.parallelTools": c.get("agent.parallelTools", true),
                "agent.toolCache": c.get("agent.toolCache", true),
                "chat.persistHistory": c.get("chat.persistHistory", true),
                "approval.write": c.get("approval.write", "ask"),
                "approval.delete": c.get("approval.delete", "ask"),
                "approval.rename": c.get("approval.rename", "ask"),
                "approval.shell": c.get("approval.shell", "ask"),
                "approval.vscodeCommand": c.get(
                    "approval.vscodeCommand",
                    "ask"
                ),
                "approval.web": c.get("approval.web", "ask"),
                "agent.customSystemPrompt": c.get("agent.customSystemPrompt", ""),
                "agent.personalization": c.get("agent.personalization", false),
                "agent.disabledTools": c.get("agent.disabledTools", []),
            },
        });
    }

    openSettingsPanel(): void {
        this.view?.webview.postMessage({ type: "openSettings" });
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        Logger.log("[chat] resolveWebviewView");
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.ctx.extensionUri, "media"),
            ],
        };
        view.webview.html = buildHtml({
            webview: view.webview,
            extensionUri: this.ctx.extensionUri,
            nonce: nonce(),
            title: "OnlySq Chat",
            bodyHtml: CHAT_BODY,
            scriptFile: "chat.js",
            cssFile: "webview.css",
        });

        this.disposeSubs();
        this.subs.push(
            view.webview.onDidReceiveMessage((m) => this.onMessage(m))
        );
        this.subs.push(this.auth.onChange((s) => this.pushAuth(s)));
        this.subs.push(
            view.onDidChangeVisibility(() => {
                if (view.visible) void this.pushAuth();
            })
        );
        this.subs.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("onlysq.chatModel"))
                    this.pushModel();
            })
        );
        this.subs.push(view.onDidDispose(() => this.disposeSubs()));
        this.subs.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("onlysq")) {
                    this.pushSettings();
                    if (e.affectsConfiguration("onlysq.chatModel"))
                        this.pushModel();
                }
            })
        );
    }

    focus(): void {
        vscode.commands.executeCommand(`${ChatView.viewId}.focus`);
    }

    async sendPrompt(
        text: string,
        mode: "chat" | "agent" = "chat"
    ): Promise<void> {
        this.focus();
        await new Promise((r) => setTimeout(r, 200));
        if (!(await this.auth.isSignedIn())) {
            await this.pushAuth();
            return;
        }
        await this.handleSend(text, mode);
    }

    private async pushAuth(state?: AuthState): Promise<void> {
        if (!this.view) return;
        this.pushSettings();
        const s = state ?? (await this.auth.getState());
        this.view.webview.postMessage({
            type: "auth",
            signed: s.signed,
            signingIn: s.signingIn,
            error: s.error ?? null,
            profile: s.profile ?? null,
        });
        if (s.signed) {
            await this.pushModels();
            this.pushModel();
        }
    }

    private async pushModels(): Promise<void> {
        const list = await this.modelsService.fetch();
        this.view?.webview.postMessage({ type: "models", list });
    }

    private pushModel(): void {
        this.view?.webview.postMessage({
            type: "model",
            id: settings().chatModel,
        });
    }

    private async onMessage(m: any): Promise<void> {
        if (m?.type === "__log") {
            Logger.log("[webview]", ...(m.args ?? []));
            return;
        }
        Logger.log("[chat] onMessage", m?.type);
        switch (m.type) {
            case "ready":
                await this.pushAuth();
                this.pushChatList();
                this.pushSettings();
                if (this.history.length) this.pushHistoryWindow("replace");
                return;

            case "signIn":
                return this.auth.signIn();

            case "signOut":
                await this.auth.signOut();
                return;

            case "send":
                if (!(await this.auth.isSignedIn())) {
                    await this.pushAuth();
                    return;
                }
                // If agent is running, queue as live message instead of starting new run
                if (this.isRunning && m.mode === "agent") {
                    this.liveMessages.push({ role: "user", content: m.text });
                    Logger.log(`[chat] queued live message during agent run: ${m.text.slice(0, 80)}`);
                    return;
                }
                return this.handleSend(m.text, m.mode);

            case "cancel":
                Logger.log("[chat] cancel requested");
                this.resumeAgent();
                for (const [, r] of this.askResolvers) r("(cancelled by user)");
                this.askResolvers.clear();
                this.aborter?.abort();
                return;

            case "answerUser":
                if (typeof m.id === "string" && typeof m.answer === "string") {
                    const r = this.askResolvers.get(m.id);
                    if (r) {
                        this.askResolvers.delete(m.id);
                        r(m.answer);
                    }
                }
                return;

            case "togglePause":
                if (this.paused) this.resumeAgent();
                else this.setPaused(true, "Paused by user");
                return;

            case "resume":
                this.resumeAgent();
                return;

            case "newChat":
                await this.chats.create();
                this.activeChat = this.chats.active();
                this.windowStart = 0;
                this.pushChatList();
                this.pushHistoryWindow("replace");
                return;

            case "switchChat":
                if (typeof m.id === "string") {
                    const c = await this.chats.setActive(m.id);
                    if (c) {
                        this.activeChat = c;
                        this.windowStart = Math.max(
                            0,
                            c.messages.length - HISTORY_WINDOW
                        );
                        this.aborter?.abort();
                        this.pushChatList();
                        this.pushHistoryWindow("replace");
                    }
                }
                return;

            case "renameChat":
                if (typeof m.id === "string" && typeof m.title === "string") {
                    await this.chats.rename(m.id, m.title);
                    if (this.activeChat && this.activeChat.id === m.id) {
                        this.activeChat.title = m.title;
                    }
                    this.pushChatList();
                }
                return;

            case "deleteChat":
                if (typeof m.id === "string") {
                    const wasActive = this.activeChat?.id === m.id;
                    await this.chats.remove(m.id);
                    if (wasActive) {
                        this.activeChat = this.chats.active();
                        this.windowStart = this.activeChat
                            ? Math.max(
                                  0,
                                  this.activeChat.messages.length -
                                      HISTORY_WINDOW
                              )
                            : 0;
                        this.pushHistoryWindow("replace");
                    }
                    this.pushChatList();
                }
                return;

            case "loadMore":
                return this.loadMore();
            case "trimToWindow":
                if (this.isRunning) {
                    Logger.log("[chat] trimToWindow ignored while running");
                    return;
                }
                return this.trimToWindow();

            case "selectModel":
                if (typeof m.model === "string") {
                    await updateSetting("chatModel", m.model);
                    this.pushModel();
                }
                return;

            case "refreshModels":
                await this.modelsService.fetch(true);
                await this.pushModels();
                return;

            case "showDiff":
                if (typeof m.id === "string") {
                    const { showDiff } = await import(
                        "../services/workspace/diffPreview"
                    );
                    await showDiff(m.id);
                }
                return;
            case "applyEdit":
                if (typeof m.id === "string") {
                    const { applyProposal, getProposalState } = await import(
                        "../services/workspace/diffPreview"
                    );
                    const ok = await applyProposal(m.id).catch(() => false);
                    this.view?.webview.postMessage({
                        type: "editResult",
                        id: m.id,
                        state: ok ? "applied" : getProposalState(m.id),
                    });
                }
                return;
            case "rejectEdit":
                if (typeof m.id === "string") {
                    const { rejectProposal } = await import(
                        "../services/workspace/diffPreview"
                    );
                    rejectProposal(m.id);
                    this.view?.webview.postMessage({
                        type: "editResult",
                        id: m.id,
                        state: "rejected",
                    });
                }
                return;

            case "editMessage":
                if (typeof m.index === "number" && typeof m.text === "string") {
                    await this.editMessageAt(
                        m.index,
                        m.text,
                        m.mode === "agent" ? "agent" : "chat"
                    );
                }
                return;

            case "regenerateAt":
                if (typeof m.index === "number") {
                    await this.regenerateAt(
                        m.index,
                        m.mode === "agent" ? "agent" : "chat"
                    );
                }
                return;

            case "getSettings":
                this.pushSettings();
                return;

            case "setSetting":
                if (typeof m.key === "string") {
                    const target = vscode.ConfigurationTarget.Global;
                    await vscode.workspace
                        .getConfiguration("onlysq")
                        .update(m.key, m.value, target);
                    this.pushSettings();
                }
                return;

            case "showLog":
                Logger.show();
                return;

            case "openDashboard":
                await vscode.env.openExternal(
                    vscode.Uri.parse(SAUTH.dashboard)
                );
                return;

            case "exportChat":
                if (typeof m.format === "string") {
                    await this.exportChat(m.format as "markdown" | "json");
                }
                return;

            case "undoLastEdit":
                if (typeof m.id === "string") {
                    const { undoProposal } = await import(
                        "../services/workspace/diffPreview"
                    );
                    const ok = await undoProposal(m.id);
                    this.view?.webview.postMessage({
                        type: "undoResult",
                        id: m.id,
                        success: ok,
                    });
                }
                return;

            case "applyAllEdits":
                if (Array.isArray(m.ids)) {
                    const { applyProposal, getProposalState } = await import(
                        "../services/workspace/diffPreview"
                    );
                    for (const id of m.ids) {
                        await applyProposal(id).catch(() => {});
                        this.view?.webview.postMessage({
                            type: "editResult",
                            id,
                            state: getProposalState(id) === "applied" ? "applied" : "error",
                        });
                    }
                }
                return;

            case "rejectAllEdits":
                if (Array.isArray(m.ids)) {
                    const { rejectProposal } = await import(
                        "../services/workspace/diffPreview"
                    );
                    for (const id of m.ids) {
                        rejectProposal(id);
                        this.view?.webview.postMessage({
                            type: "editResult",
                            id,
                            state: "rejected",
                        });
                    }
                }
                return;

            case "mentionSearch":
                if (typeof m.query === "string") {
                    const { findFiles } = await import(
                        "../services/workspace/fs"
                    );
                    const q = m.query.replace(/[\\/:]/g, "").trim();
                    const glob = q ? `**/*${q}*` : "**/*";
                    const files = await findFiles(glob, 15);
                    this.view?.webview.postMessage({
                        type: "mentionResults",
                        files,
                    });
                }
                return;

            case "readFileContent":
                if (typeof m.path === "string") {
                    try {
                        const { readText } = await import(
                            "../services/workspace/fs"
                        );
                        const text = await readText(m.path, 50_000);
                        this.view?.webview.postMessage({
                            type: "fileContent",
                            path: m.path,
                            content: text,
                        });
                    } catch {}
                }
                return;
        }
    }

    private pushChatList(): void {
        if (!this.view) return;
        this.view.webview.postMessage({
            type: "chats",
            list: this.chats.list(),
            activeId: this.activeChat?.id ?? null,
        });
    }

    private async handleSend(
        text: string,
        mode: "chat" | "agent"
    ): Promise<void> {
        await this.ensureActiveChat();

        if (this.isRunning) {
            this.aborter?.abort();
        }

        this.setPaused(false);
        this.isRunning = true;
        this.aborter?.abort();

        const aborter = new AbortController();
        this.aborter = aborter;

        try {
            if (mode === "agent") await this.runAgentMode(text, aborter.signal);
            else await this.runChatMode(text, aborter.signal);
        } catch (e: any) {
            Logger.error("[chat] send", e);
            this.post({ type: "error", message: String(e?.message ?? e) });
        } finally {
            if (this.aborter === aborter) {
                this.isRunning = false;
                this.setPaused(false);
            }
        }
    }

    private async runChatMode(
        text: string,
        signal: AbortSignal
    ): Promise<void> {
        const ctx = await editorContextSnippet();
        const userContent = ctx
            ? `${text}\n\n---\n**Editor context:**\n${ctx}`
            : text;
        const systemPrompt = `You are OnlySq CLI, a coding assistant inside VS Code.
    - Answer in Markdown with fenced code blocks (\`\`\`lang).
    - Be concise. Prefer code over prose when code is the answer.
    
    --- System context ---
    ${systemBriefForLLM()}`;

        const cleanHistory = sanitizeHistoryForApi(this.history);
        const messages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            ...cleanHistory,
            { role: "user", content: userContent },
        ];

        let acc = "";
        for await (const d of this.client.stream(
            {
                model: settings().chatModel,
                temperature: settings().temperature,
                messages,
            },
            signal
        )) {
            if (d.content) {
                acc += d.content;
                this.post({ type: "token", text: d.content });
            }
        }
        this.activeChat!.messages.push({ role: "user", content: text });
        this.activeChat!.messages.push({ role: "assistant", content: acc });
        this.post({ type: "done" });
        this.updateHistoryAfterTurn();
        await this.persistActive();
        this.pushChatList();
    }

    private async runAgentMode(
        text: string,
        signal: AbortSignal
    ): Promise<void> {
        const ctx = await editorContextSnippet();
        const goal = ctx ? `${text}\n\n---\n**Editor context:**\n${ctx}` : text;
        const cleanHistory = sanitizeHistoryForApi(this.history);
        const updated = await runAgent(
            this.client,
            this.registry,
            goal,
            (e) => {
                switch (e.type) {
                    case "token":
                        this.post({ type: "token", text: e.text });
                        break;
                    case "tool-call":
                        this.post({
                            type: "tool-call",
                            id: e.id,
                            name: e.name,
                            args: e.args,
                        });
                        break;
                    case "tool-result":
                        this.post({
                            type: "tool-result",
                            id: e.id,
                            name: e.name,
                            result: e.result,
                        });
                        break;
                    case "ask-user":
                        this.post({
                            type: "ask-user",
                            id: e.id,
                            question: e.question,
                            options: e.options,
                            multiSelect: e.multiSelect,
                        });
                        break;
                    case "pause":
                        this.setPaused(true, e.reason);
                        break;
                    case "done":
                        this.post({ type: "done", reason: e.reason });
                        break;
                    case "error":
                        this.post({ type: "error", message: e.message });
                        break;
                }
            },
            signal,
            cleanHistory,
            {
                shouldPause: () => this.paused,
                waitIfPaused: (reason?: string) => this.waitIfPaused(reason),
                askUser: (callId: string) => this.askUser(callId),
                getLiveMessages: () => {
                    const msgs = this.liveMessages.splice(0);
                    return msgs;
                },
            }
        );
        this.liveMessages = [];
        if (this.activeChat) this.activeChat.messages = updated;
        this.updateHistoryAfterTurn();
        await this.persistActive();
        this.pushChatList();
    }

    private updateHistoryAfterTurn(): void {
        this.windowStart = Math.max(0, this.history.length - HISTORY_WINDOW);
        this.notifyCanLoadMore();
    }

    private loadMore(): void {
        const next = Math.max(0, this.windowStart - HISTORY_PAGE);
        if (next === this.windowStart) return;
        const slice = this.history.slice(next, this.windowStart);
        this.windowStart = next;
        this.view?.webview.postMessage({
            type: "prepend",
            messages: serializeMessages(slice),
        });
        this.notifyCanLoadMore();
    }
    private trimToWindow(): void {
        this.windowStart = Math.max(0, this.history.length - HISTORY_WINDOW);
        this.view?.webview.postMessage({
            type: "trimTo",
            keep: this.history.length - this.windowStart,
        });
        this.notifyCanLoadMore();
    }

    private notifyCanLoadMore(): void {
        this.view?.webview.postMessage({
            type: "canLoadMore",
            value: this.windowStart > 0,
        });
    }
    private pushHistoryWindow(_mode: "replace"): void {
        const slice = this.history.slice(this.windowStart);
        this.view?.webview.postMessage({
            type: "replace",
            messages: serializeMessages(slice),
        });
        this.notifyCanLoadMore();
    }

    private setPaused(value: boolean, reason?: string): void {
        this.paused = value;
        this.view?.webview.postMessage({
            type: "pauseState",
            paused: value,
            reason: reason ?? null,
        });
    }

    private async waitIfPaused(reason?: string): Promise<void> {
        if (!this.paused) return;
        this.setPaused(true, reason);
        await new Promise<void>((resolve) => {
            this.pauseWaiter = resolve;
        });
        this.pauseWaiter = null;
    }

    private resumeAgent(): void {
        this.setPaused(false);
        const r = this.pauseWaiter;
        this.pauseWaiter = null;
        r?.();
    }

    private askUser(callId: string): Promise<string> {
        return new Promise((resolve) => {
            this.askResolvers.set(callId, resolve);
        });
    }

    private post(msg: any): void {
        this.view?.webview.postMessage(msg);
    }

    private async exportChat(format: "markdown" | "json"): Promise<void> {
        if (!this.activeChat || !this.history.length) {
            vscode.window.showWarningMessage("OnlySq: nothing to export");
            return;
        }
        const title = this.activeChat.title || "chat";
        const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

        if (format === "json") {
            const data = {
                title: this.activeChat.title,
                id: this.activeChat.id,
                createdAt: this.activeChat.createdAt,
                updatedAt: this.activeChat.updatedAt,
                messages: this.history.filter(
                    (m) => m.role === "user" || m.role === "assistant"
                ).map(m => ({ role: m.role, content: m.content ?? "" })),
            };
            const content = JSON.stringify(data, null, 2);
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${safeTitle}.json`),
                filters: { JSON: ["json"] },
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(
                    uri,
                    Buffer.from(content, "utf-8")
                );
                vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
            }
        } else {
            let md = `# ${title}\n\n`;
            for (const m of this.history) {
                if (m.role === "user") {
                    md += `## You\n\n${m.content ?? ""}\n\n`;
                } else if (m.role === "assistant") {
                    md += `## OnlySq\n\n${m.content ?? ""}\n\n`;
                }
            }
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${safeTitle}.md`),
                filters: { Markdown: ["md"] },
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(
                    uri,
                    Buffer.from(md, "utf-8")
                );
                vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
            }
        }
    }

    private disposeSubs(): void {
        for (const d of this.subs.splice(0))
            try {
                d.dispose();
            } catch {
                /* */
            }
    }

    async newChat(): Promise<void> {
        await this.chats.create();
        this.activeChat = this.chats.active();
        this.windowStart = 0;
        this.pushChatList();
        this.pushHistoryWindow("replace");
    }

    private getVisibleMessages(): ChatMessage[] {
        return this.history.filter(
            (m) => m.role === "user" || m.role === "assistant"
        );
    }

    private findRealIndexByVisible(visibleIndex: number): number {
        let count = -1;
        for (let i = 0; i < this.history.length; i++) {
            const r = this.history[i].role;
            if (r === "user" || r === "assistant") {
                count++;
                if (count === visibleIndex) return i;
            }
        }
        return -1;
    }

    private async editMessageAt(
        visibleIndex: number,
        newText: string,
        mode: "chat" | "agent"
    ): Promise<void> {
        Logger.log(
            `[chat] editMessageAt visIdx=${visibleIndex} text=${JSON.stringify(
                newText
            ).slice(0, 80)} mode=${mode}`
        );

        if (!this.activeChat) {
            Logger.log("[chat] editMessageAt: no activeChat");
            return;
        }
        const realIdx = this.findRealIndexByVisible(visibleIndex);
        Logger.log(
            `[chat] editMessageAt realIdx=${realIdx} historyLen=${this.history.length}`
        );

        if (realIdx < 0) {
            Logger.log("[chat] editMessageAt: visible index not found");
            this.view?.webview.postMessage({ type: "editCancelled" });
            return;
        }
        const msg = this.history[realIdx];
        Logger.log(`[chat] editMessageAt found role=${msg.role}`);

        if (msg.role !== "user") {
            this.view?.webview.postMessage({ type: "editCancelled" });
            return;
        }

        this.aborter?.abort();

        this.activeChat.messages = this.history.slice(0, realIdx);
        this.windowStart = Math.max(
            0,
            this.activeChat.messages.length - HISTORY_WINDOW
        );
        await this.persistActive();
        this.pushHistoryWindow("replace");
        this.pushChatList();

        Logger.log("[chat] editMessageAt: starting handleSend");
        await this.handleSend(newText.trim(), mode);
    }

    private async regenerateAt(
        visibleIndex: number,
        mode: "chat" | "agent"
    ): Promise<void> {
        if (!this.activeChat) return;
        const realIdx = this.findRealIndexByVisible(visibleIndex);
        if (realIdx < 0) return;

        let userIdx = realIdx;
        while (userIdx >= 0 && this.history[userIdx].role !== "user") userIdx--;
        if (userIdx < 0) return;

        const userMsg = this.history[userIdx];
        const userText = String(userMsg.content ?? "");

        this.aborter?.abort();

        this.activeChat.messages = this.history.slice(0, userIdx);
        this.windowStart = Math.max(
            0,
            this.activeChat.messages.length - HISTORY_WINDOW
        );
        await this.persistActive();
        this.pushHistoryWindow("replace");
        this.pushChatList();

        await this.handleSend(userText, mode);
    }
}

function serializeMessages(msgs: ChatMessage[]): Array<{
    role: string;
    content: string;
    tools?: Array<{
        id: string;
        name: string;
        args: any;
        result?: string;
        editState?: string;
    }>;
}> {
    const out: Array<any> = [];
    let i = 0;
    while (i < msgs.length) {
        const m = msgs[i];
        if (m.role === "user") {
            out.push({ role: "user", content: m.content ?? "" });
            i++;
            continue;
        }
        if (m.role === "assistant") {
            const tools: any[] = [];
            if (m.tool_calls?.length) {
                for (const tc of m.tool_calls) {
                    let args: any = {};
                    try {
                        args = JSON.parse(tc.function?.arguments || "{}");
                    } catch {
                        /* */
                    }
                    const next = msgs[i + 1 + tools.length];
                    const result =
                        next?.role === "tool" && next.tool_call_id === tc.id
                            ? next.content
                            : undefined;
                    tools.push({
                        id: tc.id,
                        name: tc.function?.name ?? "tool",
                        args,
                        result,
                    });
                }
            }
            out.push({
                role: "assistant",
                content: m.content ?? "",
                tools: tools.length ? tools : undefined,
            });
            i += 1 + tools.length;
            continue;
        }
        i++;
    }
    return out;
}

async function editorContextSnippet(): Promise<string | null> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return null;
    const doc = ed.document;

    if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") return null;

    const sel = ed.selection;
    if (sel.isEmpty) return null;

    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    const text = doc.getText(sel);
    return `File: \`${rel}\` (selection ${sel.start.line + 1}-${
        sel.end.line + 1
    })\n\`\`\`${doc.languageId}\n${text.slice(0, 8000)}\n\`\`\``;
}
