import { exists, readText } from "./fs";

export interface ReplaceOp {
    find: string;
    replace: string;
    count?: number;
}

export interface ReplaceResult {
    proposed: string;
    applied: Array<{
        index: number;
        find: string;
        matchCount: number;
        appliedCount: number;
    }>;
    notFound: Array<{ index: number; find: string }>;
    totalMatches: number;
    totalApplied: number;
}

export class ReplaceValidationError extends Error {
    constructor(message: string) {
        super(message);
    }
}

interface NormalizedFile {
    text: string;
    eol: "\r\n" | "\n";
    trailingNewline: boolean;
}

function normalize(raw: string): NormalizedFile {
    const eol: "\r\n" | "\n" = raw.includes("\r\n") ? "\r\n" : "\n";
    const stripped = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const trailingNewline = stripped.endsWith("\n");
    return {
        text: trailingNewline ? stripped.slice(0, -1) : stripped,
        eol,
        trailingNewline,
    };
}

function denormalize(file: NormalizedFile, text: string): string {
    let out = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (file.trailingNewline && !out.endsWith("\n")) out += "\n";
    if (!file.trailingNewline && out.endsWith("\n")) out = out.slice(0, -1);
    if (file.eol === "\r\n") out = out.replace(/\n/g, "\r\n");
    return out;
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while (true) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;
        count++;
        pos = idx + needle.length;
    }
    return count;
}

function replaceN(
    haystack: string,
    needle: string,
    replacement: string,
    limit: number
): { text: string; replaced: number } {
    if (!needle) return { text: haystack, replaced: 0 };
    let out = "";
    let pos = 0;
    let replaced = 0;
    while (replaced < limit) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;
        out += haystack.slice(pos, idx) + replacement;
        pos = idx + needle.length;
        replaced++;
    }
    out += haystack.slice(pos);
    return { text: out, replaced };
}

export async function previewReplaceInFile(
    path: string,
    ops: ReplaceOp[]
): Promise<ReplaceResult> {
    if (!(await exists(path))) {
        throw new ReplaceValidationError(
            `File does not exist: ${path}. Use propose_edit to create new files.`
        );
    }
    const original = await readText(path);
    const file = normalize(original);

    const applied: ReplaceResult["applied"] = [];
    const notFound: ReplaceResult["notFound"] = [];
    let current = file.text;
    let totalMatches = 0;
    let totalApplied = 0;

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const find = String(op.find ?? "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
        const replace = String(op.replace ?? "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
        if (!find) {
            notFound.push({ index: i, find: "(empty)" });
            continue;
        }
        const matchCount = countOccurrences(current, find);
        if (matchCount === 0) {
            notFound.push({ index: i, find });
            continue;
        }
        const limit =
            op.count && op.count > 0 ? op.count : Number.POSITIVE_INFINITY;
        const { text, replaced } = replaceN(current, find, replace, limit);
        current = text;
        applied.push({ index: i, find, matchCount, appliedCount: replaced });
        totalMatches += matchCount;
        totalApplied += replaced;
    }

    return {
        proposed: denormalize(file, current),
        applied,
        notFound,
        totalMatches,
        totalApplied,
    };
}
