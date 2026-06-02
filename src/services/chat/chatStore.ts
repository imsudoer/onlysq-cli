import * as vscode from "vscode";
import { ChatMessage } from "../llm/types";
import { STORAGE_KEYS, settings } from "../../core/config";

const MAX_MESSAGES_PER_CHAT = 500;
const MAX_CHATS = 50;

export interface ChatSession {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ChatMessage[];
}

export interface ChatSummary {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    preview: string;
}

interface StorageShape {
    activeId: string | null;
    chats: ChatSession[];
}

export class ChatStore {
    private state: StorageShape;
    private readonly _onChange = new vscode.EventEmitter<void>();
    readonly onChange = this._onChange.event;

    constructor(private ctx: vscode.ExtensionContext) {
        const raw = ctx.workspaceState.get<StorageShape>(
            STORAGE_KEYS.chatHistory
        );
        this.state = this.normalize(raw);
    }

    private normalize(raw: any): StorageShape {
        if (!raw || !Array.isArray(raw.chats))
            return { activeId: null, chats: [] };
        const chats = raw.chats
            .filter(
                (c: any) =>
                    c && typeof c.id === "string" && Array.isArray(c.messages)
            )
            .map((c: any) => ({
                id: c.id,
                title: typeof c.title === "string" ? c.title : "Untitled",
                createdAt: Number(c.createdAt) || Date.now(),
                updatedAt: Number(c.updatedAt) || Date.now(),
                messages: c.messages.slice(-MAX_MESSAGES_PER_CHAT),
            }))
            .slice(-MAX_CHATS);
        const activeId =
            typeof raw.activeId === "string" &&
            chats.find((c: ChatSession) => c.id === raw.activeId)
                ? raw.activeId
                : chats[chats.length - 1]?.id ?? null;
        return { activeId, chats };
    }

    private async persist(): Promise<void> {
        if (!settings().persistHistory) return;
        await this.ctx.workspaceState.update(
            STORAGE_KEYS.chatHistory,
            this.state
        );
        this._onChange.fire();
    }

    list(): ChatSummary[] {
        return [...this.state.chats]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((c) => ({
                id: c.id,
                title: c.title,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
                messageCount: c.messages.filter(
                    (m) => m.role === "user" || m.role === "assistant"
                ).length,
                preview: this.previewOf(c),
            }));
    }

    private previewOf(c: ChatSession): string {
        const firstUser = c.messages.find((m) => m.role === "user");
        if (!firstUser) return "(empty)";
        const raw = firstUser.content;
        const text = (typeof raw === "string" ? raw : (raw ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ")).replace(/\s+/g, " ").trim();
        return text.length > 80 ? text.slice(0, 80) + "…" : text;
    }

    activeId(): string | null {
        return this.state.activeId;
    }

    active(): ChatSession | null {
        const id = this.state.activeId;
        return id ? this.state.chats.find((c) => c.id === id) ?? null : null;
    }

    get(id: string): ChatSession | null {
        return this.state.chats.find((c) => c.id === id) ?? null;
    }

    async create(title?: string): Promise<ChatSession> {
        const id = `c_${Date.now().toString(36)}_${Math.random()
            .toString(36)
            .slice(2, 7)}`;
        const now = Date.now();
        const chat: ChatSession = {
            id,
            title: title?.trim() || "New chat",
            createdAt: now,
            updatedAt: now,
            messages: [],
        };
        this.state.chats.push(chat);
        if (this.state.chats.length > MAX_CHATS) {
            const oldest = this.state.chats
                .filter((c) => c.id !== id)
                .sort((a, b) => a.updatedAt - b.updatedAt)[0];
            if (oldest)
                this.state.chats = this.state.chats.filter(
                    (c) => c.id !== oldest.id
                );
        }
        this.state.activeId = id;
        await this.persist();
        return chat;
    }

    async setActive(id: string): Promise<ChatSession | null> {
        const c = this.get(id);
        if (!c) return null;
        this.state.activeId = id;
        await this.persist();
        return c;
    }

    async updateMessages(id: string, messages: ChatMessage[]): Promise<void> {
        const c = this.get(id);
        if (!c) return;
        c.messages = messages.slice(-MAX_MESSAGES_PER_CHAT);
        c.updatedAt = Date.now();
        if (c.title === "New chat" || !c.title) {
            const firstUser = c.messages.find((m) => m.role === "user");
            if (firstUser?.content) {
                const ct = firstUser.content;
                const t = typeof ct === "string" ? ct : ct.filter(p => p.type === "text").map(p => (p as any).text).join(" ");
                c.title = this.autoTitle(t);
            }
        }
        await this.persist();
    }

    private autoTitle(text: string): string {
        const t = text.replace(/\s+/g, " ").trim();
        return t.length > 40 ? t.slice(0, 40) + "…" : t || "New chat";
    }

    async rename(id: string, title: string): Promise<void> {
        const c = this.get(id);
        if (!c) return;
        c.title = title.trim() || c.title;
        c.updatedAt = Date.now();
        await this.persist();
    }

    async remove(id: string): Promise<ChatSession | null> {
        const idx = this.state.chats.findIndex((c) => c.id === id);
        if (idx === -1) return null;
        const removed = this.state.chats.splice(idx, 1)[0];
        if (this.state.activeId === id) {
            this.state.activeId =
                this.state.chats[this.state.chats.length - 1]?.id ?? null;
        }
        await this.persist();
        return removed;
    }

    async clearAll(): Promise<void> {
        this.state = { activeId: null, chats: [] };
        await this.persist();
    }
}
