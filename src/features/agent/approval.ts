import * as vscode from "vscode";
import { ToolPolicy, settings } from "../../core/config";

/**
 * Check tool policy. Returns:
 * - true  → execute
 * - false → denied / disabled
 */
export async function askToolApproval(
    toolName: string,
    prompt: string
): Promise<boolean> {
    const policy: ToolPolicy = settings().toolPolicy[toolName] ?? "ask";
    if (policy === "disabled") return false;
    if (policy === "always") return true;
    if (policy === "never") return false;
    // "ask"
    const c = await vscode.window.showWarningMessage(
        prompt,
        { modal: true },
        "Allow",
        "Deny"
    );
    return c === "Allow";
}

/** Check if a tool is disabled (should not be sent to the model at all). */
export function isToolDisabled(toolName: string): boolean {
    return settings().toolPolicy[toolName] === "disabled";
}
