import { Logger } from "../../core/logger";

interface Entry {
    abort: () => void;
    kind: string;
}

const entries = new Map<string, Entry>();

export function registerCancellable(callId: string, abort: () => void, kind = "tool"): void {
    entries.set(callId, { abort, kind });
}

export function unregisterCancellable(callId: string): void {
    entries.delete(callId);
}

export function cancelTool(callId: string): boolean {
    const e = entries.get(callId);
    if (!e) return false;
    Logger.log(`[cancel] cancelling ${e.kind} call ${callId}`);
    try {
        e.abort();
    } catch (err) {
        Logger.error(`[cancel] abort threw for ${callId}`, err);
    }
    entries.delete(callId);
    return true;
}

export function isCancellable(callId: string): boolean {
    return entries.has(callId);
}

export function listCancellable(): Array<{ id: string; kind: string }> {
    return [...entries.entries()].map(([id, e]) => ({ id, kind: e.kind }));
}
