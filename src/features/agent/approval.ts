import * as vscode from "vscode";
import { ApprovalMode, settings } from "../../core/config";

export type ApprovalKind =
    | "write"
    | "delete"
    | "rename"
    | "shell"
    | "vscodeCommand"
    | "web";

export async function askApproval(
    kind: ApprovalKind,
    prompt: string
): Promise<boolean> {
    const mode: ApprovalMode = settings().approval[kind];
    if (mode === "always") return true;
    if (mode === "never") return false;
    const c = await vscode.window.showWarningMessage(
        prompt,
        { modal: true },
        "Allow",
        "Deny"
    );
    return c === "Allow";
}
