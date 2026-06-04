import { ChatMessage } from "./types";

function hasTextContent(c: ChatMessage["content"]): boolean {
    if (!c) return false;
    if (typeof c === "string") return c.trim().length > 0;
    if (Array.isArray(c)) {
        for (const p of c) {
            if ((p as any)?.type === "text" && typeof (p as any).text === "string" && (p as any).text.trim()) {
                return true;
            }
        }
    }
    return false;
}

export function stripToolMessages(history: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of history) {
        if (m.role === "tool") continue;
        if (m.role === "assistant" && m.tool_calls?.length) {
            if (hasTextContent(m.content)) {
                out.push({ role: "assistant", content: m.content });
            }
            continue;
        }
        out.push(m);
    }
    return out;
}

export function sanitizeHistoryForApi(history: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let i = 0; i < history.length; i++) {
        const m = history[i];
        if (m.role === "assistant" && m.tool_calls?.length) {
            const need = new Set(m.tool_calls.map((tc) => tc.id));
            const seen = new Set<string>();
            let j = i + 1;
            while (j < history.length && history[j].role === "tool") {
                const tcId = history[j].tool_call_id;
                if (tcId) seen.add(tcId);
                j++;
            }
            if (
                need.size === seen.size &&
                [...need].every((id) => seen.has(id))
            ) {
                out.push(m);
            } else {
                out.push({
                    role: "assistant",
                    content:
                        m.content ||
                        "[Tool call cut short, continuing from here]",
                });
                while (j > i + 1) {
                    j--;
                    i++;
                }
            }
        } else if (m.role === "tool") {
            const prev = out[out.length - 1];
            if (
                prev?.role === "assistant" &&
                prev.tool_calls?.some((tc) => tc.id === m.tool_call_id)
            ) {
                out.push(m);
            }
        } else {
            out.push(m);
        }
    }
    return out;
}
