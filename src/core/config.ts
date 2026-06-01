import * as vscode from "vscode";

export const SAUTH = {
    apiBase: "https://api.onlysq.ru",
    authPage: "https://my.onlysq.ru/sauth",
    dashboard: "https://my.onlysq.ru",
    clientId: "app-40f3b6bb1b822d-0d6c0b27",
    clientSecret: "dm8vsXC_jezqIRukBRX7cVh0jnMcKWPhsyB9Rp64q28",
    redirectUri: "http://127.0.0.1:53120/sauth",
    port: 53120,
    path: "/sauth",
    scopes: [
        "profile.id",
        "profile.name",
        "profile.email",
        "profile.level",
        "profile.balance",
        "ai.readKeys",
    ],
} as const;

export const AI = {
    apiBase: "https://api.onlysq.ru/ai/openai",
    modelsPath: "/models",
    chatPath: "/chat/completions",
} as const;

export const STORAGE_KEYS = {
    accessToken: "onlysq.accessToken",
    expiresAt: "onlysq.expiresAt",
    apiKey: "onlysq.apiKey",
    profile: "onlysq.profile",
    models: "onlysq.models",
    chatHistory: "onlysq.chatHistory",
    sessionUsage: "onlysq.sessionUsage",
} as const;

export type ApprovalMode = "always" | "never" | "ask";

export interface Settings {
    chatModel: string;
    completionModel: string;
    inlineEnabled: boolean;
    autoTrigger: boolean;
    contextLinesBefore: number;
    contextLinesAfter: number;
    temperature: number;
    maxAgentSteps: number;
    approval: {
        write: ApprovalMode;
        delete: ApprovalMode;
        rename: ApprovalMode;
        shell: ApprovalMode;
        vscodeCommand: ApprovalMode;
    };
    parallelTools: boolean;
    toolCache: boolean;
    persistHistory: boolean;
}

export function settings(): Settings {
    const c = vscode.workspace.getConfiguration("onlysq");
    const ap = (key: string, def: ApprovalMode): ApprovalMode => {
        const v = c.get<string>(`approval.${key}`, def);
        return v === "always" || v === "never" || v === "ask" ? v : def;
    };
    return {
        chatModel: c.get("chatModel", "gpt-4o-mini"),
        completionModel: c.get("completionModel", "gpt-4o-mini"),
        inlineEnabled: c.get("inlineCompletions.enabled", true),
        autoTrigger: c.get("inlineCompletions.autoTrigger", true),
        contextLinesBefore: c.get("inlineCompletions.linesBefore", 80),
        contextLinesAfter: c.get("inlineCompletions.linesAfter", 40),
        temperature: c.get("temperature", 0.3),
        maxAgentSteps: c.get("agent.maxSteps", 50),
        approval: {
            write: ap("write", "ask"),
            delete: ap("delete", "ask"),
            rename: ap("rename", "ask"),
            shell: ap("shell", "ask"),
            vscodeCommand: ap("vscodeCommand", "ask"),
        },
        parallelTools: c.get("agent.parallelTools", true),
        toolCache: c.get("agent.toolCache", true),
        persistHistory: c.get("chat.persistHistory", true),
    };
}

export async function updateSetting<K extends keyof Settings>(
    key: K,
    value: any,
    target = vscode.ConfigurationTarget.Global
): Promise<void> {
    const map: Record<string, string> = {
        chatModel: "chatModel",
        completionModel: "completionModel",
        inlineEnabled: "inlineCompletions.enabled",
        autoTrigger: "inlineCompletions.autoTrigger",
        contextLinesBefore: "inlineCompletions.linesBefore",
        contextLinesAfter: "inlineCompletions.linesAfter",
        temperature: "temperature",
        maxAgentSteps: "agent.maxSteps",
        parallelTools: "agent.parallelTools",
        toolCache: "agent.toolCache",
        persistHistory: "chat.persistHistory",
    };
    await vscode.workspace
        .getConfiguration("onlysq")
        .update(map[String(key)] ?? String(key), value, target);
}
