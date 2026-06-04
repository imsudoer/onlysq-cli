import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "../../core/logger";

export interface TerminalSession {
    id: string;
    cwd: string;
    shell: string;
    proc: cp.ChildProcessWithoutNullStreams;
    buffer: string;
    closed: boolean;
    exitCode: number | null;
    createdAt: number;
}

const sessions = new Map<string, TerminalSession>();
let counter = 0;

const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_SESSIONS = 8;

function pickShell(): { shell: string; args: string[] } {
    const env = process.env;
    if (process.platform === "win32") {
        const ps = env.PSModulePath ? "powershell.exe" : "cmd.exe";
        if (ps === "powershell.exe") {
            return { shell: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"] };
        }
        return { shell: "cmd.exe", args: ["/Q", "/K"] };
    }
    const sh = env.SHELL || "/bin/bash";
    return { shell: sh, args: ["-i"] };
}

function workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return folder.uri.fsPath;
    return os.homedir();
}

export function openSession(opts?: { cwd?: string }): TerminalSession {
    if (sessions.size >= MAX_SESSIONS) {
        for (const s of sessions.values()) {
            if (s.closed) {
                sessions.delete(s.id);
                break;
            }
        }
        if (sessions.size >= MAX_SESSIONS) {
            throw new Error(`Max ${MAX_SESSIONS} concurrent terminal sessions. Close some first.`);
        }
    }
    const cwd = opts?.cwd ? path.resolve(workspaceRoot(), opts.cwd) : workspaceRoot();
    const { shell, args } = pickShell();
    const id = "term-" + ++counter;
    Logger.log(`[terminal] open ${id} shell=${shell} cwd=${cwd}`);
    const proc = cp.spawn(shell, args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        windowsHide: true,
    });
    const session: TerminalSession = {
        id,
        cwd,
        shell,
        proc,
        buffer: "",
        closed: false,
        exitCode: null,
        createdAt: Date.now(),
    };
    const append = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        session.buffer += text;
        if (session.buffer.length > MAX_BUFFER_BYTES) {
            session.buffer = "\u2026(truncated)\n" + session.buffer.slice(-MAX_BUFFER_BYTES);
        }
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    proc.on("exit", (code) => {
        session.closed = true;
        session.exitCode = code;
        Logger.log(`[terminal] ${id} exited code=${code}`);
    });
    proc.on("error", (err) => {
        session.buffer += `\n[spawn error] ${err.message}\n`;
        session.closed = true;
    });
    sessions.set(id, session);
    return session;
}

export function writeToSession(id: string, text: string): void {
    const s = sessions.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    if (s.closed) throw new Error(`Session ${id} is closed (exit ${s.exitCode})`);
    const payload = text.endsWith("\n") ? text : text + "\n";
    s.proc.stdin.write(payload);
}

export async function readFromSession(id: string, opts?: { waitMs?: number; clear?: boolean }): Promise<{ output: string; closed: boolean; exitCode: number | null }> {
    const s = sessions.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    const waitMs = Math.max(0, Math.min(30000, opts?.waitMs ?? 1000));
    if (waitMs > 0 && !s.closed) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
    const output = s.buffer;
    if (opts?.clear !== false) s.buffer = "";
    return { output, closed: s.closed, exitCode: s.exitCode };
}

export function closeSession(id: string): boolean {
    const s = sessions.get(id);
    if (!s) return false;
    if (!s.closed) {
        try {
            s.proc.kill();
        } catch { /* ignore */ }
    }
    sessions.delete(id);
    Logger.log(`[terminal] closed ${id}`);
    return true;
}

export function listSessions(): Array<{ id: string; cwd: string; shell: string; closed: boolean; exitCode: number | null; bufferBytes: number; ageMs: number }> {
    const now = Date.now();
    return Array.from(sessions.values()).map((s) => ({
        id: s.id,
        cwd: s.cwd,
        shell: path.basename(s.shell),
        closed: s.closed,
        exitCode: s.exitCode,
        bufferBytes: Buffer.byteLength(s.buffer, "utf8"),
        ageMs: now - s.createdAt,
    }));
}

export function disposeAllSessions(): void {
    for (const id of Array.from(sessions.keys())) {
        closeSession(id);
    }
}
