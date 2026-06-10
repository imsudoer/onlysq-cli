import * as vscode from "vscode";
import * as path from "path";
import { resolve, readText, writeText } from "./fs";

class DiffContentProvider implements vscode.TextDocumentContentProvider {
    private readonly content = new Map<string, string>();
    private readonly _onChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onChange.event;

    set(uri: vscode.Uri, text: string): void {
        this.content.set(uri.toString(), text);
        this._onChange.fire(uri);
    }
    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.content.get(uri.toString()) ?? "";
    }
}

const SCHEME = "onlysq-diff";
const provider = new DiffContentProvider();
let registered = false;

export function registerDiffProvider(ctx: vscode.ExtensionContext): void {
    if (registered) return;
    ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider)
    );
    registered = true;
}

export type ProposalState = "pending" | "applied" | "rejected";

export interface ProposedChange {
    id: string;
    path: string;
    newContent: string;
    reason?: string;
}

interface StoredProposal extends ProposedChange {
    state: ProposalState;
    leftUri: vscode.Uri;
    rightUri: vscode.Uri;
    title: string;
    exists: boolean;
    originalContent: string;
}

const proposals = new Map<string, StoredProposal>();

export async function createProposal(
    change: ProposedChange
): Promise<StoredProposal> {
    const rel = change.path.replace(/^\/+/, "");
    let original = "";
    let exists = true;
    try {
        original = await readText(rel);
    } catch {
        exists = false;
    }

    const stamp = Date.now();
    const leftUri = vscode.Uri.parse(
        `${SCHEME}:Original/${rel}?${change.id}-${stamp}`
    );
    const rightUri = vscode.Uri.parse(
        `${SCHEME}:Proposed/${rel}?${change.id}-${stamp}`
    );
    provider.set(leftUri, original);
    provider.set(rightUri, change.newContent);

    const stored: StoredProposal = {
        ...change,
        state: "pending",
        leftUri,
        rightUri,
        title: `OnlySq: ${exists ? "Edit" : "Create"} ${path.basename(rel)}`,
        exists,
        originalContent: original,
    };
    proposals.set(change.id, stored);
    return stored;
}

export async function showDiff(id: string): Promise<void> {
    const p = proposals.get(id);
    if (!p) {
        vscode.window.showWarningMessage("OnlySq: diff not available");
        return;
    }
    await vscode.commands.executeCommand(
        "vscode.diff",
        p.leftUri,
        p.rightUri,
        p.title,
        { preview: true }
    );
}

export async function applyProposal(id: string): Promise<boolean> {
    const p = proposals.get(id);
    if (!p) return false;
    if (p.state === "applied") return true;
    const rel = p.path.replace(/^\/+/, "");
    await writeText(rel, p.newContent);
    p.state = "applied";
    // Don't overwrite leftUri — keep original content so View diff still shows before/after
    return true;
}

export function rejectProposal(id: string): void {
    const p = proposals.get(id);
    if (!p) return;
    p.state = "rejected";
}

export function getProposalState(id: string): ProposalState | "unknown" {
    return proposals.get(id)?.state ?? "unknown";
}

export function getProposal(id: string): StoredProposal | undefined {
    return proposals.get(id);
}

export async function undoProposal(id: string): Promise<boolean> {
    const p = proposals.get(id);
    if (!p || p.state !== "applied") return false;
    const rel = p.path.replace(/^\/+/, "");
    if (p.exists) {
        await writeText(rel, p.originalContent);
    } else {
        // file was created — delete it
        try {
            const uri = resolve(rel);
            await vscode.workspace.fs.delete(uri);
        } catch { /* ignore */ }
    }
    p.state = "pending";
    provider.set(p.leftUri, p.originalContent);
    return true;
}

export function getAllPendingIds(): string[] {
    const ids: string[] = [];
    for (const [id, p] of proposals) {
        if (p.state === "pending") ids.push(id);
    }
    return ids;
}

export function hasPendingEdits(): boolean {
    for (const [, p] of proposals) {
        if (p.state === "pending") return true;
    }
    return false;
}

export function listPendingEdits(): Array<{ id: string; path: string }> {
    const out: Array<{ id: string; path: string }> = [];
    for (const [id, p] of proposals) {
        if (p.state === "pending") out.push({ id, path: p.path });
    }
    return out;
}

export function abandonPendingEdits(): string[] {
    const abandoned: string[] = [];
    for (const [id, p] of proposals) {
        if (p.state === "pending") {
            p.state = "rejected";
            abandoned.push(id);
        }
    }
    return abandoned;
}

export function waitForPendingEdits(signal?: AbortSignal, timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve) => {
        if (!hasPendingEdits()) { resolve(); return; }
        const startedAt = Date.now();
        const interval = setInterval(() => {
            const timedOut = Date.now() - startedAt > timeoutMs;
            if (!hasPendingEdits() || signal?.aborted || timedOut) {
                clearInterval(interval);
                resolve();
            }
        }, 200);
    });
}
