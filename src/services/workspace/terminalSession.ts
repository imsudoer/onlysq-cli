import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as os from "os";
import { Logger } from "../../core/logger";

export interface TerminalSession {
    id: string;
    cwd: string;
    shell: string;
    proc: ChildProcessWithoutNullStreams;
    terminal: vscode.Terminal;
    buffer: string;
    bufferBytes: number;
    closed: boolean;
    exitCode: number | null;
    createdAt: number;
    userInputChars: number;
    userInputBuffer: string;
    lastUserInputAt: number;
}

export interface OpenSessionOpts {
    cwd?: string;
    show?: boolean;
}

export interface ReadSessionOpts {
    waitMs?: number;
    clear?: boolean;
}

export interface SessionInfo {
    id: string;
    cwd: string;
    shell: string;
    closed: boolean;
    exitCode: number | null;
    bufferBytes: number;
    ageMs: number;
    userInputChars: number;
    userInputBuffer: string;
    lastUserInputAt: number;
}

export interface ReadResult {
    output: string;
    closed: boolean;
    exitCode: number | null;
    userInputSinceLastRead?: string;
}

const sessions = new Map<string, TerminalSession>();
let counter = 0;

export interface UserInputEvent {
    sessionId: string;
    data: string;
    at: number;
}
const userInputListeners = new Set<(e: UserInputEvent) => void>();

export function onUserInput(listener: (e: UserInputEvent) => void): () => void {
    userInputListeners.add(listener);
    return () => userInputListeners.delete(listener);
}

function emitUserInput(sessionId: string, data: string): void {
    const ev: UserInputEvent = { sessionId, data, at: Date.now() };
    for (const l of userInputListeners) {
        try { l(ev); } catch { /* ignore */ }
    }
}

function defaultShell(): { cmd: string; args: string[] } {
    if (process.platform === "win32") {
        return { cmd: "powershell.exe", args: ["-NoLogo", "-NoExit", "-Command", "-"] };
    }
    const sh = process.env.SHELL || "/bin/bash";
    return { cmd: sh, args: ["-i"] };
}

function resolveCwd(cwd?: string): string {
    if (cwd) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0 && !/^([a-z]:|\/|\\)/i.test(cwd)) {
            return vscode.Uri.joinPath(folders[0].uri, cwd).fsPath;
        }
        return cwd;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    return os.homedir();
}

function stripAnsi(s: string): string {
    return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

class SessionPty implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    readonly onDidWrite = this.writeEmitter.event;
    readonly onDidClose = this.closeEmitter.event;

    private session?: TerminalSession;

    attach(session: TerminalSession): void {
        this.session = session;
    }

    open(): void {
        this.writeEmitter.fire(
            `\x1b[36mOnlySq Terminal Session ${this.session?.id ?? ""}\x1b[0m\r\n` +
                `\x1b[2mcwd: ${this.session?.cwd}\x1b[0m\r\n\r\n`
        );
    }

    write(data: string): void {
        this.writeEmitter.fire(data);
    }

    close(): void {
        this.closeEmitter.fire();
    }

    fireExit(code: number): void {
        this.closeEmitter.fire(code);
    }

    handleInput(data: string): void {
        if (!this.session || this.session.closed) return;
        try {
            this.session.proc.stdin.write(data);
            const printable = data.replace(/[\x00-\x08\x0E-\x1F\x7F]/g, "");
            if (printable) {
                this.session.userInputBuffer += printable;
                this.session.userInputChars += printable.length;
                this.session.lastUserInputAt = Date.now();
                emitUserInput(this.session.id, printable);
            }
        } catch (e) {
            Logger.error("[terminal] pty input write failed", e);
        }
    }
}

export function openSession(opts: OpenSessionOpts = {}): TerminalSession {
    const id = "term-" + (++counter);
    const resolvedCwd = resolveCwd(opts.cwd);
    const { cmd, args } = defaultShell();

    Logger.log(`[terminal] opening session ${id} cwd=${resolvedCwd} shell=${cmd}`);

    const proc = spawn(cmd, args, {
        cwd: resolvedCwd,
        env: { ...process.env, FORCE_COLOR: "1" },
        windowsHide: true,
    });

    const pty = new SessionPty();
    const terminal = vscode.window.createTerminal({
        name: `OnlySq: ${id}`,
        pty,
        iconPath: new vscode.ThemeIcon("terminal"),
    } as vscode.ExtensionTerminalOptions);

    const session: TerminalSession = {
        id,
        cwd: resolvedCwd,
        shell: cmd,
        proc,
        terminal,
        buffer: "",
        bufferBytes: 0,
        closed: false,
        exitCode: null,
        createdAt: Date.now(),
        userInputChars: 0,
        userInputBuffer: "",
        lastUserInputAt: 0,
    };
    pty.attach(session);

    const onStdout = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        const clean = stripAnsi(text);
        session.buffer += clean;
        session.bufferBytes = session.buffer.length;
        pty.write(text.replace(/\r?\n/g, "\r\n"));
    };
    proc.stdout.on("data", onStdout);
    proc.stderr.on("data", onStdout);

    proc.on("exit", (code) => {
        session.closed = true;
        session.exitCode = code;
        pty.write(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`);
        pty.fireExit(code ?? 0);
        Logger.log(`[terminal] session ${id} exited code=${code}`);
    });

    proc.on("error", (e) => {
        session.closed = true;
        pty.write(`\r\n\x1b[31m[error: ${e.message}]\x1b[0m\r\n`);
        Logger.error(`[terminal] session ${id} error`, e);
    });

    sessions.set(id, session);
    if (opts.show !== false) {
        try { terminal.show(true); } catch { /* ignore */ }
    }
    return session;
}

export function writeToSession(id: string, text: string): boolean {
    const s = sessions.get(id);
    if (!s || s.closed) return false;
    const data = text.endsWith("\n") ? text : text + "\n";
    try {
        s.proc.stdin.write(data);
        return true;
    } catch (e) {
        Logger.error(`[terminal] write failed for ${id}`, e);
        return false;
    }
}

export async function readFromSession(
    id: string,
    opts: ReadSessionOpts = {}
): Promise<ReadResult> {
    const s = sessions.get(id);
    if (!s) {
        return { output: "(no such session)", closed: true, exitCode: null };
    }
    const waitMs = opts.waitMs != null ? Math.min(Math.max(0, opts.waitMs), 30000) : 1000;
    const clear = opts.clear !== false;
    if (waitMs > 0 && !s.closed) {
        await new Promise((r) => setTimeout(r, waitMs));
    }
    const output = s.buffer;
    const userInput = s.userInputBuffer;
    if (clear) {
        s.buffer = "";
        s.bufferBytes = 0;
        s.userInputBuffer = "";
    }
    return {
        output,
        closed: s.closed,
        exitCode: s.exitCode,
        userInputSinceLastRead: userInput || undefined,
    };
}

export function closeSession(id: string): boolean {
    const s = sessions.get(id);
    if (!s) return false;
    if (!s.closed) {
        try {
            s.proc.kill();
        } catch (e) {
            Logger.error(`[terminal] kill failed for ${id}`, e);
        }
    }
    try {
        s.terminal.dispose();
    } catch { /* ignore */ }
    sessions.delete(id);
    return true;
}

export function peekSession(id: string): {
    output: string;
    userInputBuffer: string;
    closed: boolean;
    exitCode: number | null;
} | null {
    const s = sessions.get(id);
    if (!s) return null;
    return {
        output: s.buffer,
        userInputBuffer: s.userInputBuffer,
        closed: s.closed,
        exitCode: s.exitCode,
    };
}

export function listSessions(): SessionInfo[] {
    const now = Date.now();
    return Array.from(sessions.values()).map((s) => ({
        id: s.id,
        cwd: s.cwd,
        shell: s.shell,
        closed: s.closed,
        exitCode: s.exitCode,
        bufferBytes: s.bufferBytes,
        ageMs: now - s.createdAt,
        userInputChars: s.userInputBuffer.length,
        userInputBuffer: s.userInputBuffer,
        lastUserInputAt: s.lastUserInputAt,
    }));
}

export function showSession(id: string): boolean {
    const s = sessions.get(id);
    if (!s) return false;
    s.terminal.show(false);
    return true;
}

export function disposeAllSessions(): void {
    for (const s of sessions.values()) {
        try { s.proc.kill(); } catch { /* ignore */ }
        try { s.terminal.dispose(); } catch { /* ignore */ }
    }
    sessions.clear();
}
