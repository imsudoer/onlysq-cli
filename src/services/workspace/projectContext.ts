import { exists, readText, writeText, resolve } from "./fs";

const CONTEXT_PATH = ".onlysq/context.md";
const MAX_BYTES = 32_000;

export function projectContextPath(): string {
    return CONTEXT_PATH;
}

export async function hasProjectContext(): Promise<boolean> {
    try {
        return await exists(CONTEXT_PATH);
    } catch {
        return false;
    }
}

export async function readProjectContext(): Promise<string | null> {
    try {
        if (!(await exists(CONTEXT_PATH))) return null;
        const text = await readText(CONTEXT_PATH, MAX_BYTES);
        return text.trim() ? text : null;
    } catch {
        return null;
    }
}

export async function writeProjectContext(content: string): Promise<void> {
    await writeText(CONTEXT_PATH, content);
}

export function projectContextUri() {
    return resolve(CONTEXT_PATH);
}

export function truncateForPrompt(text: string, max = 6000): string {
    if (text.length <= max) return text;
    return text.slice(0, max) + "\n…[truncated]";
}
