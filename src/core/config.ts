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
    embeddingsPath: "/embeddings",
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

export type ToolPolicy = "always" | "ask" | "never" | "disabled";

/** Default policies per tool */
export const TOOL_DEFAULTS: Record<string, ToolPolicy> = {
    // Read-only / safe
    pause_agent: "always", ask_user: "always", read_file: "always",
    list_dir: "always", list_tree: "always", search: "always",
    find_files: "always", file_info: "always", find_in_file: "always",
    semantic_search: "always",
    open_file: "always", goto_position: "always", get_cursor: "always",
    get_selection: "always", list_open_files: "always", get_diagnostics: "always",
    list_tasks: "always", git_status: "always", git_diff: "always",
    workspace_info: "always", system_info: "always", delegate: "always",
    add_memory: "always", get_memory: "always", view_memories: "always", delete_memory: "always",
    add_global_memory: "always", get_global_memory: "always", view_global_memories: "always", delete_global_memory: "always",
    create_task: "always", update_task: "always", delete_task: "always", list_agent_tasks: "always",
    read_project_context: "always", get_my_config: "always",
    // Write
    propose_edit: "ask", apply_at_line: "ask", replace_in_file: "ask",
    patch_file: "ask", delete_file: "ask", rename_file: "ask",
    update_project_context: "ask",
    // Shell / commands
    run_command: "ask", run_command_interactive: "ask", run_task: "ask",
    run_vscode_command: "ask", open_in_browser: "ask", git_commit: "ask",
    terminal: "ask",
    // Web
    fetch_url: "ask", web_search: "ask", scrape_page: "ask",
    read_image: "always", screenshot_url: "ask",
};

export interface Settings {
    chatModel: string;
    completionModel: string;
    embeddingModel: string;
    inlineEnabled: boolean;
    autoTrigger: boolean;
    contextLinesBefore: number;
    contextLinesAfter: number;
    temperature: number;
    maxAgentSteps: number;
    toolPolicy: Record<string, ToolPolicy>;
    parallelTools: boolean;
    toolCache: boolean;
    persistHistory: boolean;
    customSystemPrompt: string;
    personalization: boolean;
}

export function settings(): Settings {
    const c = vscode.workspace.getConfiguration("onlysq");
    // Per-tool policy: merge defaults with user overrides
    const overrides = c.get<Record<string, string>>("agent.toolPolicy", {});
    const toolPolicy: Record<string, ToolPolicy> = { ...TOOL_DEFAULTS };
    for (const [name, val] of Object.entries(overrides)) {
        if (val === "always" || val === "ask" || val === "never" || val === "disabled") {
            toolPolicy[name] = val;
        }
    }

    return {
        chatModel: c.get("chatModel", "gpt-4o-mini"),
        completionModel: c.get("completionModel", "gpt-4o-mini"),
        embeddingModel: c.get("embeddingModel", "pplx-embed-v1-4b"),
        inlineEnabled: c.get("inlineCompletions.enabled", true),
        autoTrigger: c.get("inlineCompletions.autoTrigger", true),
        contextLinesBefore: c.get("inlineCompletions.linesBefore", 80),
        contextLinesAfter: c.get("inlineCompletions.linesAfter", 40),
        temperature: c.get("temperature", 0.3),
        maxAgentSteps: c.get("agent.maxSteps", 50),
        toolPolicy,
        parallelTools: c.get("agent.parallelTools", true),
        toolCache: c.get("agent.toolCache", true),
        persistHistory: c.get("chat.persistHistory", true),
        customSystemPrompt: c.get("agent.customSystemPrompt", ""),
        personalization: c.get("agent.personalization", false),
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
        embeddingModel: "embeddingModel",
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
