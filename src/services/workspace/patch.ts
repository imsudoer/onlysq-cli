import { readText, exists } from "./fs";

interface Hunk {
    oldStart: number;
    lines: string[];
}

export interface PatchPreview {
    path: string;
    proposed: string;
    exists: boolean;
}

export class PatchValidationError extends Error {
    constructor(message: string) {
        super(message);
    }
}

interface NormalizedFile {
    lines: string[];
    eol: "\r\n" | "\n";
    trailingNewline: boolean;
}

function normalize(raw: string): NormalizedFile {
    const eol: "\r\n" | "\n" = raw.includes("\r\n") ? "\r\n" : "\n";
    const stripped = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const trailingNewline = stripped.endsWith("\n");
    const body = trailingNewline ? stripped.slice(0, -1) : stripped;
    return { lines: body.split("\n"), eol, trailingNewline };
}

function rejoin(file: NormalizedFile, lines: string[]): string {
    let joined = lines.join(file.eol);
    if (file.trailingNewline) joined += file.eol;
    return joined;
}

export async function applyUnifiedDiff(
    path: string,
    diff: string
): Promise<PatchPreview> {
    const ex = await exists(path);
    const original = ex ? await readText(path) : "";
    const file = normalize(original);
    const hunks = parseHunks(diff);
    if (!hunks.length)
        throw new PatchValidationError("No @@ hunks found in diff");
    const proposedLines = applyHunks(file.lines, hunks, path);
    return { path, proposed: rejoin(file, proposedLines), exists: ex };
}

function parseHunks(diff: string): Hunk[] {
    const lines = diff.split("\n");
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    for (const line of lines) {
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
        if (m) {
            if (cur) hunks.push(cur);
            cur = { oldStart: parseInt(m[1], 10), lines: [] };
            continue;
        }
        if (!cur) continue;
        if (
            line.startsWith("---") ||
            line.startsWith("+++") ||
            line.startsWith("diff ") ||
            line.startsWith("index ")
        )
            continue;
        cur.lines.push(line.replace(/\r$/, ""));
    }
    if (cur) hunks.push(cur);
    return hunks;
}

function applyHunks(src: string[], hunks: Hunk[], path: string): string[] {
    const out: string[] = [];
    let cursor = 0;

    for (const h of hunks) {
        const target = Math.max(0, h.oldStart - 1);
        if (target > src.length) {
            throw new PatchValidationError(
                `Hunk start ${h.oldStart} is past end of file (${src.length} lines) in ${path}`
            );
        }
        while (cursor < target && cursor < src.length) out.push(src[cursor++]);

        for (const ln of h.lines) {
            if (ln.startsWith("+")) {
                out.push(ln.slice(1));
            } else if (ln.startsWith("-")) {
                if (cursor >= src.length) {
                    throw new PatchValidationError(
                        `Hunk wants to remove past end of file in ${path}`
                    );
                }
                const expected = ln.slice(1);
                if (src[cursor] !== expected) {
                    throw new PatchValidationError(
                        `Diff context mismatch at ${path}:${cursor + 1}.\n` +
                            `Expected: ${expected}\n` +
                            `Actual:   ${src[cursor]}\n` +
                            `Re-read the file with read_file and regenerate the diff.`
                    );
                }
                cursor++;
            } else if (ln.startsWith(" ")) {
                if (cursor >= src.length) {
                    throw new PatchValidationError(
                        `Hunk context line past end of file in ${path}`
                    );
                }
                const expected = ln.slice(1);
                if (src[cursor] !== expected) {
                    throw new PatchValidationError(
                        `Diff context mismatch at ${path}:${cursor + 1}.\n` +
                            `Expected: ${expected}\n` +
                            `Actual:   ${src[cursor]}\n` +
                            `Re-read the file with read_file and regenerate the diff.`
                    );
                }
                out.push(src[cursor]);
                cursor++;
            }
        }
    }
    while (cursor < src.length) out.push(src[cursor++]);
    return out;
}
