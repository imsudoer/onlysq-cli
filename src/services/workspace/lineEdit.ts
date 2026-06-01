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
    const lines = original.split("\n");
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
        const stripPrefix = (s: string) => s.replace(/^\s*\d+\s*\|\s?/, "");
        const expectedClean = edit.expectedLines.map(stripPrefix);
        const actual = lines.slice(start, start + expectedClean.length);
        if (
            actual.length !== expectedClean.length ||
            actual.some((l, i) => l !== expectedClean[i])
        ) {
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

    const repl = edit.replacement.split("\n");
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
        proposed: next.join("\n"),
        exists: ex,
        originalRange,
        totalLines,
    };
}
