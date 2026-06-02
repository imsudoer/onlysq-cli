import * as vscode from "vscode";
import * as path from "path";

const IGNORE =
    /(?:^|\/)(?:node_modules|\.git|out|dist|build|\.next|\.cache|__pycache__|venv|\.venv)(?:\/|$)/;

export function root(): vscode.Uri {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) throw new Error("No workspace folder open");
    return ws;
}

export function resolve(rel: string): vscode.Uri {
    return vscode.Uri.joinPath(root(), rel);
}

export function rel(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
}

export async function exists(rel: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(resolve(rel));
        return true;
    } catch {
        return false;
    }
}

export async function stat(rel: string): Promise<vscode.FileStat | null> {
    try {
        return await vscode.workspace.fs.stat(resolve(rel));
    } catch {
        return null;
    }
}

export async function readText(
    rel: string,
    maxBytes = 200_000_000
): Promise<string> {
    const data = await vscode.workspace.fs.readFile(resolve(rel));
    return new TextDecoder().decode(
        data.length > maxBytes ? data.slice(0, maxBytes) : data
    );
}

export async function writeText(rel: string, content: string): Promise<void> {
    const uri = resolve(rel);
    await ensureDir(path.posix.dirname(rel));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

export async function ensureDir(rel: string): Promise<void> {
    if (!rel || rel === "." || rel === "/") return;
    try {
        await vscode.workspace.fs.createDirectory(resolve(rel));
    } catch {
        /* */
    }
}

export async function deleteFile(rel: string): Promise<void> {
    await vscode.workspace.fs.delete(resolve(rel), {
        recursive: true,
        useTrash: true,
    });
}

export async function renameFile(from: string, to: string): Promise<void> {
    await vscode.workspace.fs.rename(resolve(from), resolve(to), {
        overwrite: false,
    });
}

export async function listDir(
    rel: string
): Promise<{ name: string; kind: "file" | "dir" }[]> {
    const entries = await vscode.workspace.fs.readDirectory(
        resolve(rel || ".")
    );
    return entries
        .filter(([n]) => !IGNORE.test(n))
        .map(([n, t]) => ({
            name: n,
            kind:
                t === vscode.FileType.Directory
                    ? ("dir" as const)
                    : ("file" as const),
        }))
        .sort((a, b) =>
            a.kind === b.kind
                ? a.name.localeCompare(b.name)
                : a.kind === "dir"
                ? -1
                : 1
        );
}

export async function listTree(
    rel: string,
    maxDepth = 3,
    maxItems = 200
): Promise<string[]> {
    const out: string[] = [];
    async function walk(p: string, depth: number) {
        if (depth > maxDepth || out.length >= maxItems) return;
        let entries;
        try {
            entries = await vscode.workspace.fs.readDirectory(resolve(p));
        } catch {
            return;
        }
        for (const [name, kind] of entries) {
            if (IGNORE.test(name)) continue;
            if (out.length >= maxItems) return;
            const full = p ? `${p}/${name}` : name;
            const indent = "  ".repeat(depth);
            const mark = kind === vscode.FileType.Directory ? "/" : "";
            out.push(`${indent}${name}${mark}`);
            if (kind === vscode.FileType.Directory) await walk(full, depth + 1);
        }
    }
    await walk(rel || "", 0);
    return out;
}

export async function searchText(
    pattern: string,
    glob = "**/*",
    limit = 50
): Promise<string[]> {
    const files = await vscode.workspace.findFiles(
        glob,
        "**/{node_modules,.git,out,dist,build,venv,.venv}/**",
        500
    );
    const re = new RegExp(pattern, "g");
    const out: string[] = [];
    for (const f of files) {
        if (out.length >= limit) break;
        try {
            const txt = new TextDecoder().decode(
                await vscode.workspace.fs.readFile(f)
            );
            const lines = txt.split("\n");
            for (let i = 0; i < lines.length && out.length < limit; i++) {
                re.lastIndex = 0;
                if (re.test(lines[i]))
                    out.push(`${rel(f)}:${i + 1}: ${lines[i].slice(0, 240)}`);
            }
        } catch {
            /* binary */
        }
    }
    return out;
}

export async function findFiles(glob: string, limit = 100): Promise<string[]> {
    const files = await vscode.workspace.findFiles(
        glob,
        "**/{node_modules,.git,out,dist,build,venv,.venv}/**",
        limit
    );
    return files.map((f) => rel(f));
}

export interface DiagnosticEntry {
    file: string;
    line: number;
    column: number;
    severity: string;
    source?: string;
    message: string;
}

export function getDiagnostics(filter?: string): DiagnosticEntry[] {
    const out: DiagnosticEntry[] = [];
    const all = vscode.languages.getDiagnostics();
    for (const [uri, diags] of all) {
        const r = rel(uri);
        if (filter && !r.includes(filter)) continue;
        for (const d of diags) {
            out.push({
                file: r,
                line: d.range.start.line + 1,
                column: d.range.start.character + 1,
                severity: vscode.DiagnosticSeverity[d.severity],
                source: d.source,
                message: d.message,
            });
        }
    }
    return out;
}

export async function readTextWithLineNumbers(
    rel: string,
    opts: { start?: number; end?: number; maxBytes?: number } = {}
): Promise<{
    text: string;
    totalLines: number;
    truncated: boolean;
    rangeStart: number;
    rangeEnd: number;
    eol: string;
}> {
    const data = await vscode.workspace.fs.readFile(resolve(rel));
    const maxBytes = opts.maxBytes ?? 200_000;
    const truncated = data.length > maxBytes;
    const raw = new TextDecoder().decode(
        truncated ? data.slice(0, maxBytes) : data
    );

    const eol = raw.includes("\r\n") ? "CRLF" : "LF";
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const allLines = normalized.split("\n");
    const totalLines = allLines.length;

    const start = Math.max(1, opts.start ?? 1);
    const end = Math.min(totalLines, opts.end ?? totalLines);
    const slice = allLines.slice(start - 1, end);

    const width = String(end).length;
    const numbered = slice
        .map((line, i) => {
            const n = String(start + i).padStart(width, " ");
            return `${n} | ${line}`;
        })
        .join("\n");

    return {
        text: numbered,
        totalLines,
        truncated,
        rangeStart: start,
        rangeEnd: end,
        eol,
    };
}
