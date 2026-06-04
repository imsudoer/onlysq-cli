import * as vscode from "vscode";
import * as crypto from "crypto";
import { Logger } from "../../core/logger";
import { resolve, rel, exists, readText, writeText, ensureDir } from "../workspace/fs";
import { EmbeddingsClient } from "../llm/embeddingsClient";

const INDEX_PATH = ".onlysq/index.json";
const INDEX_VERSION = 1;

const DEFAULT_MODEL = "text-embedding-3-small";
const CHUNK_MAX_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 200;
const BATCH_SIZE = 64;
const BATCH_CONCURRENCY = 3;
const MAX_FILE_BYTES = 500_000;
const SEARCH_GLOB = "**/*";
const EXCLUDE_GLOB =
    "**/{node_modules,.git,out,dist,build,.next,.cache,__pycache__,venv,.venv,.onlysq,target,vendor,coverage}/**";

const BINARY_EXT = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "ico", "svg",
    "pdf", "zip", "tar", "gz", "rar", "7z",
    "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi",
    "ttf", "otf", "woff", "woff2", "eot",
    "exe", "dll", "so", "dylib", "bin", "wasm",
    "lock",
]);

export interface IndexChunk {
    startLine: number;
    endLine: number;
    text: string;
    embedding: number[];
}

export interface IndexFileEntry {
    mtime: number;
    size: number;
    sha: string;
    chunks: IndexChunk[];
}

export interface IndexFile {
    version: number;
    model: string;
    updatedAt: number;
    files: Record<string, IndexFileEntry>;
}

export interface IndexProgress {
    phase: "scan" | "embed" | "save" | "done";
    filesTotal: number;
    filesProcessed: number;
    filesUnchanged: number;
    chunksEmbedded: number;
    currentFile?: string;
}

export interface IndexerOpts {
    model?: string;
    signal?: AbortSignal;
    onProgress?: (p: IndexProgress) => void;
}

function sha256(s: string): string {
    return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function looksBinary(data: Uint8Array): boolean {
    const sample = data.subarray(0, Math.min(data.length, 4096));
    let nullCount = 0;
    for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) nullCount++;
        if (nullCount > 2) return true;
    }
    return false;
}

export function chunkText(text: string): Array<{ startLine: number; endLine: number; text: string }> {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];

    let buf = "";
    let bufStart = 1;
    let curLine = 1;

    const flush = (endLine: number) => {
        if (!buf.trim()) {
            buf = "";
            bufStart = endLine + 1;
            return;
        }
        chunks.push({
            startLine: bufStart,
            endLine,
            text: buf,
        });
        const overlap = buf.slice(Math.max(0, buf.length - CHUNK_OVERLAP_CHARS));
        const overlapLines = overlap.split("\n").length - 1;
        buf = overlap;
        bufStart = Math.max(bufStart, endLine - overlapLines + 1);
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        curLine = i + 1;
        const nextLen = buf.length + line.length + 1;
        if (nextLen > CHUNK_MAX_CHARS && buf.length > 0) {
            flush(curLine - 1);
        }
        buf += (buf ? "\n" : "") + line;
    }
    if (buf.trim()) {
        chunks.push({ startLine: bufStart, endLine: curLine, text: buf });
    }
    return chunks;
}

export class WorkspaceIndexer {
    constructor(private embeddings: EmbeddingsClient) {}

    async loadIndex(): Promise<IndexFile | null> {
        try {
            if (!(await exists(INDEX_PATH))) return null;
            const raw = await readText(INDEX_PATH);
            const parsed = JSON.parse(raw) as IndexFile;
            if (parsed.version !== INDEX_VERSION) {
                Logger.log(`[index] version mismatch (got ${parsed.version}, expected ${INDEX_VERSION}) — discarding`);
                return null;
            }
            return parsed;
        } catch (e: any) {
            Logger.error("[index] loadIndex failed", e);
            return null;
        }
    }

    async dropIndex(): Promise<void> {
        if (await exists(INDEX_PATH)) {
            await vscode.workspace.fs.delete(resolve(INDEX_PATH), { useTrash: false });
            Logger.log("[index] dropped");
        }
    }

    async indexWorkspace(opts: IndexerOpts = {}): Promise<IndexFile> {
        const model = opts.model || DEFAULT_MODEL;
        const onProgress = opts.onProgress;
        const signal = opts.signal;

        const existing = await this.loadIndex();
        const carryFiles: Record<string, IndexFileEntry> = {};
        if (existing && existing.model === model) {
            Object.assign(carryFiles, existing.files);
        }

        const filesUri = await vscode.workspace.findFiles(SEARCH_GLOB, EXCLUDE_GLOB, 5000);
        const candidates = filesUri.map((u) => rel(u)).filter((p) => {
            const ext = p.split(".").pop()?.toLowerCase() || "";
            if (BINARY_EXT.has(ext)) return false;
            if (p.endsWith(".min.js") || p.endsWith(".min.css")) return false;
            return true;
        });
        const filesTotal = candidates.length;
        Logger.log(`[index] scan: ${filesTotal} candidate file(s)`);

        let processed = 0;
        let unchanged = 0;
        let chunksEmbedded = 0;
        const nextFiles: Record<string, IndexFileEntry> = {};
        const presentSet = new Set(candidates);

        const toEmbed: Array<{ path: string; chunkIdx: number; text: string }> = [];
        const pendingFiles: Record<string, IndexFileEntry> = {};

        for (const p of candidates) {
            if (signal?.aborted) throw new Error("indexing aborted");
            try {
                const uri = resolve(p);
                const stat = await vscode.workspace.fs.stat(uri);
                const mtime = stat.mtime;
                const size = stat.size;
                if (size > MAX_FILE_BYTES) {
                    processed++;
                    onProgress?.({ phase: "scan", filesTotal, filesProcessed: processed, filesUnchanged: unchanged, chunksEmbedded, currentFile: p });
                    continue;
                }
                const prev = carryFiles[p];
                if (prev && prev.mtime === mtime && prev.size === size) {
                    nextFiles[p] = prev;
                    unchanged++;
                    processed++;
                    onProgress?.({ phase: "scan", filesTotal, filesProcessed: processed, filesUnchanged: unchanged, chunksEmbedded, currentFile: p });
                    continue;
                }
                const data = await vscode.workspace.fs.readFile(uri);
                if (looksBinary(data)) {
                    processed++;
                    continue;
                }
                const text = new TextDecoder().decode(data);
                if (!text.trim()) {
                    processed++;
                    continue;
                }
                const sha = sha256(text);
                if (prev && prev.sha === sha) {
                    nextFiles[p] = { ...prev, mtime, size };
                    unchanged++;
                    processed++;
                    onProgress?.({ phase: "scan", filesTotal, filesProcessed: processed, filesUnchanged: unchanged, chunksEmbedded, currentFile: p });
                    continue;
                }
                const chunks = chunkText(text);
                if (!chunks.length) {
                    processed++;
                    continue;
                }
                pendingFiles[p] = {
                    mtime,
                    size,
                    sha,
                    chunks: chunks.map((c) => ({ startLine: c.startLine, endLine: c.endLine, text: c.text, embedding: [] })),
                };
                for (let i = 0; i < chunks.length; i++) {
                    toEmbed.push({ path: p, chunkIdx: i, text: chunks[i].text });
                }
                processed++;
                onProgress?.({ phase: "scan", filesTotal, filesProcessed: processed, filesUnchanged: unchanged, chunksEmbedded, currentFile: p });
            } catch (e) {
                Logger.error(`[index] file ${p} failed`, e);
                processed++;
            }
        }

        Logger.log(`[index] ${unchanged} unchanged, ${toEmbed.length} chunk(s) to embed across ${Object.keys(pendingFiles).length} file(s)`);

        const batches: typeof toEmbed[] = [];
        for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
            batches.push(toEmbed.slice(i, i + BATCH_SIZE));
        }

        const runBatch = async (batch: typeof toEmbed) => {
            if (signal?.aborted) throw new Error("aborted");
            const inputs = batch.map((b) => b.text);
            const resp = await this.embeddings.embed({ model, input: inputs }, signal);
            for (const item of resp.data) {
                const target = batch[item.index];
                if (!target) continue;
                const fileEntry = pendingFiles[target.path];
                if (!fileEntry) continue;
                fileEntry.chunks[target.chunkIdx].embedding = item.embedding;
            }
            chunksEmbedded += batch.length;
            onProgress?.({ phase: "embed", filesTotal, filesProcessed: processed, filesUnchanged: unchanged, chunksEmbedded });
        };

        let cursor = 0;
        async function worker() {
            while (cursor < batches.length) {
                const idx = cursor++;
                await runBatch(batches[idx]);
            }
        }
        const workers: Promise<void>[] = [];
        for (let w = 0; w < Math.min(BATCH_CONCURRENCY, batches.length); w++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        for (const [p, entry] of Object.entries(pendingFiles)) {
            nextFiles[p] = entry;
        }

        const finalFiles: Record<string, IndexFileEntry> = {};
        for (const p of Object.keys(nextFiles)) {
            if (presentSet.has(p)) finalFiles[p] = nextFiles[p];
        }

        const out: IndexFile = {
            version: INDEX_VERSION,
            model,
            updatedAt: Date.now(),
            files: finalFiles,
        };

        onProgress?.({ phase: "save", filesTotal, filesProcessed: processed, filesUnchanged: unchanged, chunksEmbedded });
        await ensureDir(".onlysq");
        await writeText(INDEX_PATH, JSON.stringify(out));
        Logger.log(`[index] saved: ${Object.keys(finalFiles).length} file(s), embedded ${chunksEmbedded} new chunk(s)`);

        onProgress?.({ phase: "done", filesTotal, filesProcessed: processed, filesUnchanged: unchanged, chunksEmbedded });
        return out;
    }
}

export function indexPath(): string {
    return INDEX_PATH;
}
