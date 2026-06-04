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
        fuzzy?: boolean;
    }>;
    notFound: Array<{ index: number; find: string; hint?: string }>;
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

function squashWs(s: string): string {
    return s
        .split("\n")
        .map((l) => l.replace(/[ \t]+/g, " ").trim())
        .join("\n");
}

function findFuzzyRange(
    haystack: string,
    needle: string
): { start: number; end: number } | null {
    const needleSquashed = squashWs(needle);
    if (!needleSquashed) return null;
    const needleLines = needle.split("\n");
    const haystackLines = haystack.split("\n");
    const firstNeedleLine = squashWs(needleLines[0]);
    if (!firstNeedleLine) return null;

    for (let i = 0; i + needleLines.length <= haystackLines.length; i++) {
        if (squashWs(haystackLines[i]) !== firstNeedleLine) continue;
        const slice = haystackLines
            .slice(i, i + needleLines.length)
            .join("\n");
        if (squashWs(slice) === needleSquashed) {
            const start =
                haystackLines.slice(0, i).reduce((a, l) => a + l.length, 0) + i;
            const end = start + slice.length;
            return { start, end };
        }
    }
    return null;
}

function applyFuzzy(
    haystack: string,
    needle: string,
    replacement: string,
    limit: number
): { text: string; replaced: number } {
    let current = haystack;
    let replaced = 0;
    let cursor = 0;
    while (replaced < limit) {
        const tail = current.slice(cursor);
        const range = findFuzzyRange(tail, needle);
        if (!range) break;
        const absStart = cursor + range.start;
        const absEnd = cursor + range.end;
        current = current.slice(0, absStart) + replacement + current.slice(absEnd);
        cursor = absStart + replacement.length;
        replaced++;
    }
    return { text: current, replaced };
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = a.length;
    const n = b.length;
    if (Math.abs(m - n) > 200) return Math.max(m, n);
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(
                curr[j - 1] + 1,
                prev[j] + 1,
                prev[j - 1] + cost
            );
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

function buildHint(haystack: string, needle: string): string | undefined {
    const needleFirst = needle.split("\n")[0].trim();
    if (!needleFirst || needleFirst.length < 4) return undefined;
    const lines = haystack.split("\n");
    let bestLine = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    const cap = Math.max(needleFirst.length, 80);
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l) continue;
        const probe = l.length > cap ? l.slice(0, cap) : l;
        const d = levenshtein(needleFirst, probe);
        if (d < bestScore) {
            bestScore = d;
            bestLine = i;
        }
    }
    if (bestLine < 0) return undefined;
    const threshold = Math.max(3, Math.floor(needleFirst.length * 0.4));
    if (bestScore > threshold) return undefined;
    const actual = lines[bestLine];
    const preview = actual.length > 160 ? actual.slice(0, 160) + "…" : actual;
    return `closest line ${bestLine + 1} (distance ${bestScore}): ${JSON.stringify(preview)}`;
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
        const limit =
            op.count && op.count > 0 ? op.count : Number.POSITIVE_INFINITY;

        const matchCount = countOccurrences(current, find);
        if (matchCount > 0) {
            const { text, replaced } = replaceN(current, find, replace, limit);
            current = text;
            applied.push({ index: i, find, matchCount, appliedCount: replaced });
            totalMatches += matchCount;
            totalApplied += replaced;
            continue;
        }

        const fuzzy = applyFuzzy(current, find, replace, limit);
        if (fuzzy.replaced > 0) {
            current = fuzzy.text;
            applied.push({
                index: i,
                find,
                matchCount: fuzzy.replaced,
                appliedCount: fuzzy.replaced,
                fuzzy: true,
            });
            totalMatches += fuzzy.replaced;
            totalApplied += fuzzy.replaced;
            continue;
        }

        const hint = buildHint(current, find);
        notFound.push({ index: i, find, hint });
    }

    return {
        proposed: denormalize(file, current),
        applied,
        notFound,
        totalMatches,
        totalApplied,
    };
}
