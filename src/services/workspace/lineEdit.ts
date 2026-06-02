import { readText, exists } from "./fs";

export type EditMode = "replace" | "insert_before" | "insert_after";

export interface LineEdit {
    path: string;
    startLine: number;
    endLine?: number;
    replacement: string;
    mode: EditMode;
    expectedLines?: string[];
}

export interface LineEditPreview {
    path: string;
    proposed: string;
    exists: boolean;
    originalRange: string;
    totalLines: number;
}

export class LineEditValidationError extends Error {
    constructor(message: string, public details?: any) {
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

function stripLineNumberPrefix(s: string): string {
    return s.replace(/^\s*\d+\s*\|\s?/, "").replace(/\r$/, "");
}

export async function previewLineEdit(
    edit: LineEdit
): Promise<LineEditPreview> {
    const ex = await exists(edit.path);
    if (!ex && edit.mode !== "insert_before" && edit.mode !== "insert_after") {
        if (edit.startLine !== 1) {
            throw new LineEditValidationError(
                `File ${edit.path} does not exist. For new files use propose_edit.`
            );
        }
    }
    const original = ex ? await readText(edit.path) : "";
    const file = normalize(original);
    const lines = file.lines;
    const totalLines = lines.length;

    const start = edit.startLine - 1;
    const endIdx = (edit.endLine ?? edit.startLine) - 1;

    if (
        start < 0 ||
        start >= totalLines + (edit.mode === "insert_after" ? 1 : 0)
    ) {
        throw new LineEditValidationError(
            `start_line ${edit.startLine} out of range. File has ${totalLines} lines.`,
            { totalLines }
        );
    }
    if (edit.mode === "replace") {
        if (endIdx < start || endIdx >= totalLines) {
            throw new LineEditValidationError(
                `end_line ${
                    edit.endLine ?? edit.startLine
                } out of range. File has ${totalLines} lines.`,
                { totalLines }
            );
        }
    }

    if (edit.expectedLines && edit.expectedLines.length) {
        const expected = edit.expectedLines.map(stripLineNumberPrefix);
        const actual = lines.slice(start, start + expected.length);
        const matches =
            actual.length === expected.length &&
            actual.every((l, i) => l === expected[i]);
        if (!matches) {
            throw new LineEditValidationError(
                `expected_lines mismatch at ${edit.path}:${edit.startLine}. ` +
                    `Actual lines at this position:\n` +
                    actual
                        .map((l, i) => `  ${edit.startLine + i} | ${l}`)
                        .join("\n") +
                    `\n\nRe-read the file with read_file (using start_line/end_line) and retry.`
            );
        }
    }

    const repl = edit.replacement
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n");

    let next: string[];
    if (edit.mode === "replace") {
        next = [...lines.slice(0, start), ...repl, ...lines.slice(endIdx + 1)];
    } else if (edit.mode === "insert_before") {
        next = [...lines.slice(0, start), ...repl, ...lines.slice(start)];
    } else {
        next = [
            ...lines.slice(0, endIdx + 1),
            ...repl,
            ...lines.slice(endIdx + 1),
        ];
    }

    const originalRange = lines
        .slice(start, edit.mode === "replace" ? endIdx + 1 : start + 1)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join("\n");

    return {
        path: edit.path,
        proposed: rejoin(file, next),
        exists: ex,
        originalRange,
        totalLines,
    };
}
