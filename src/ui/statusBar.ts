import * as vscode from "vscode";
import { AuthService, AuthState } from "../services/auth/authService";
import { UsageTracker } from "../services/llm/usageTracker";
import { BRAND } from "../core/branding";

export class StatusBar implements vscode.Disposable {
    private auth$: vscode.StatusBarItem;
    private usage$: vscode.StatusBarItem;
    private subs: vscode.Disposable[] = [];

    constructor(private auth: AuthService, private usage: UsageTracker) {
        this.auth$ = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.usage$ = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            99
        );
        this.auth$.show();
        this.subs.push(auth.onChange((s) => this.renderAuth(s)));
        this.subs.push(usage.onChange(() => this.renderUsage()));
        void this.refresh();
    }

    private async refresh(): Promise<void> {
        this.renderAuth(await this.auth.getState());
        this.renderUsage();
    }

    private renderAuth(s: AuthState): void {
        if (s.signingIn) {
            this.auth$.text = `$(sync~spin) OnlySq`;
            this.auth$.tooltip = "Signing in…";
            this.auth$.command = undefined;
            this.auth$.color = BRAND.accent;
            return;
        }
        if (!s.signed) {
            this.auth$.text = `$(sign-in) OnlySq`;
            this.auth$.tooltip = "Sign in to OnlySq CLI";
            this.auth$.command = "onlysq.signIn";
            this.auth$.color = undefined;
            return;
        }
        const p = s.profile;
        this.auth$.text = `$(sparkle) ${p?.name ?? "OnlySq"}`;
        const balance =
            p?.balance != null
                ? `\nBalance: $${Number(p.balance).toFixed(4)}`
                : "";
        this.auth$.tooltip = `OnlySq CLI${
            p?.email ? ` — ${p.email}` : ""
        }${balance}\nClick to open chat`;
        this.auth$.command = "onlysq.openChat";
        this.auth$.color = BRAND.accent;
    }

    private renderUsage(): void {
        const u = this.usage.current;
        if (!u.requests && !u.totalTokens) {
            this.usage$.hide();
            return;
        }
        const human = formatTokens(u.totalTokens);
        this.usage$.text = `$(symbol-numeric) ${human}`;
        this.usage$.tooltip =
            `Session usage (live)\n` +
            `Requests: ${u.requests}\n` +
            `Prompt: ${u.promptTokens.toLocaleString()}\n` +
            `Completion: ${u.completionTokens.toLocaleString()}\n` +
            `Total: ${u.totalTokens.toLocaleString()}\n` +
            `Click to reset`;
        this.usage$.command = "onlysq.resetUsage";
        this.usage$.show();
    }

    dispose(): void {
        for (const d of this.subs.splice(0))
            try {
                d.dispose();
            } catch {
                /* */
            }
        this.auth$.dispose();
        this.usage$.dispose();
    }
}

function formatTokens(n: number): string {
    if (n < 1000) return `${n} tok`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
    return `${(n / 1_000_000).toFixed(2)}M tok`;
}
