import * as vscode from "vscode";
import { AuthService, AuthState } from "../services/auth/authService";
import { SAUTH } from "../core/config";
import { buildHtml, nonce } from "./webview/shared";
import { Logger } from "../core/logger";

const SETTINGS_BODY = `
<header class="head">
  <div class="title">Settings</div>
</header>
<main class="settings-body">
  <section class="card" id="account">
    <div class="card-title">Account</div>
    <div id="accountBody" class="rows"></div>
    <div class="actions" id="accountActions"></div>
  </section>

  <section class="card">
    <div class="card-title">Configuration</div>
    <p class="muted small">Models, completions and agent behaviour are configured in VS Code settings.</p>
    <div class="actions">
      <button class="btn" data-cmd="openSettings">Open settings</button>
    </div>
  </section>

  <section class="card">
    <div class="card-title">Diagnostics</div>
    <div class="actions">
      <button class="btn ghost" data-cmd="showLog">Show log</button>
      <button class="btn ghost" data-cmd="openDashboard">Open dashboard</button>
    </div>
  </section>
</main>
`;

export class SettingsView implements vscode.WebviewViewProvider {
    static readonly viewId = "onlysq.settings";

    private view?: vscode.WebviewView;
    private subs: vscode.Disposable[] = [];

    constructor(
        private ctx: vscode.ExtensionContext,
        private auth: AuthService
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
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
            title: "OnlySq Settings",
            bodyHtml: SETTINGS_BODY,
            scriptFile: "settings.js",
            cssFile: "webview.css",
        });

        this.dispose();
        this.subs.push(
            view.webview.onDidReceiveMessage((m) => this.onMessage(m))
        );
        this.subs.push(this.auth.onChange((s) => this.push(s)));
        this.subs.push(
            view.onDidChangeVisibility(() => {
                if (view.visible) void this.push();
            })
        );
        this.subs.push(view.onDidDispose(() => this.dispose()));
    }

    private async push(state?: AuthState): Promise<void> {
        if (!this.view) return;
        const s = state ?? (await this.auth.getState());
        const p = s.profile ?? {};
        this.view.webview.postMessage({
            type: "state",
            signed: s.signed,
            signingIn: s.signingIn,
            error: s.error ?? null,
            profile: {
                name: p.name ?? null,
                email: p.email ?? null,
                level: p.level ?? null,
                balance:
                    p.balance != null ? Number(p.balance).toFixed(4) : null,
                id: p.id ?? null,
            },
        });
    }

    private async onMessage(m: any): Promise<void> {
        if (m?.type === "__log") {
            Logger.log("[settings webview]", ...(m.args ?? []));
            return;
        }
        switch (m.type) {
            case "ready":
                return this.push();
            case "signIn":
                return this.auth.signIn();
            case "signOut":
                return this.auth.signOut();
            case "openSettings":
                return void vscode.commands.executeCommand(
                    "workbench.action.openSettings",
                    "@ext:subashev.onlysq-cli"
                );
            case "openDashboard":
                return void vscode.env.openExternal(
                    vscode.Uri.parse(SAUTH.dashboard)
                );
            case "showLog":
                return void vscode.commands.executeCommand("subashev.showLog");
            case "refresh":
                await this.auth.getApiKey(true).catch(() => {});
                return;
        }
    }

    private dispose(): void {
        for (const d of this.subs.splice(0)) {
            try {
                d.dispose();
            } catch {
                /* */
            }
        }
    }
}
