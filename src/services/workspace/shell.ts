import * as cp from "child_process";
import { systemInfo } from "../../core/systemInfo";
import { root } from "./fs";

export interface ShellResult {
    command: string;
    cwd: string;
    code: number | null;
    signal: string | null;
    timedOut: boolean;
    cancelled: boolean;
    stdout: string;
    stderr: string;
}

export interface ShellOptions {
    cwd?: string;
    timeoutMs?: number;
    maxBytes?: number;
    abortSignal?: AbortSignal;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BYTES = 64_000;

export function executeShell(
    command: string,
    opts: ShellOptions = {}
): Promise<ShellResult> {
    return new Promise((resolveP) => {
        const sys = systemInfo();
        const cwd = opts.cwd ? resolveCwd(opts.cwd) : root().fsPath;
        const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
        const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

        const { exe, args } = wrapForShell(command, sys.shell);

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let cancelled = false;
        let killed = false;

        const child = cp.spawn(exe, args, { cwd, env: process.env });

        const cancelHandler = () => {
            if (killed) return;
            cancelled = true;
            killed = true;
            try { child.kill("SIGTERM"); } catch { /* */ }
            setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, 1500);
        };
        if (opts.abortSignal) {
            if (opts.abortSignal.aborted) cancelHandler();
            else opts.abortSignal.addEventListener("abort", cancelHandler, { once: true });
        }

        const cap = (chunk: Buffer, into: "out" | "err") => {
            const text = chunk.toString("utf8");
            if (into === "out") {
                if (stdout.length < maxBytes) stdout += text;
                if (stdout.length >= maxBytes)
                    stdout =
                        stdout.slice(0, maxBytes) + "\n…(stdout truncated)";
            } else {
                if (stderr.length < maxBytes) stderr += text;
                if (stderr.length >= maxBytes)
                    stderr =
                        stderr.slice(0, maxBytes) + "\n…(stderr truncated)";
            }
        };

        child.stdout.on("data", (c) => cap(c, "out"));
        child.stderr.on("data", (c) => cap(c, "err"));

        const timer = setTimeout(() => {
            timedOut = true;
            killed = true;
            try {
                child.kill("SIGTERM");
            } catch {
                /* */
            }
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* */
                }
            }, 2_000);
        }, timeout);

        child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", cancelHandler);
            resolveP({
                command,
                cwd,
                code,
                signal,
                timedOut,
                cancelled,
                stdout: stdout.trimEnd(),
                stderr: stderr.trimEnd(),
            });
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", cancelHandler);
            resolveP({
                command,
                cwd,
                code: null,
                signal: null,
                timedOut: killed && !cancelled,
                cancelled,
                stdout,
                stderr: `${stderr}\nspawn error: ${e.message}`.trim(),
            });
        });
    });
}

function wrapForShell(
    command: string,
    shell: string
): { exe: string; args: string[] } {
    switch (shell) {
        case "powershell": {
            const encoded = Buffer.from(command, "utf16le").toString("base64");
            return {
                exe: "powershell.exe",
                args: [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-EncodedCommand",
                    encoded,
                ],
            };
        }
        case "cmd":
            return { exe: "cmd.exe", args: ["/d", "/s", "/c", command] };
        default:
            return { exe: "/bin/sh", args: ["-c", command] };
    }
}

function resolveCwd(rel: string): string {
    const r = root().fsPath;
    if (!rel || rel === "." || rel === "./") return r;
    if (/^([a-zA-Z]:\\|\/)/.test(rel)) return rel;
    return require("path").resolve(r, rel);
}

export function formatShellResult(r: ShellResult): string {
    const lines: string[] = [];
    lines.push(`Command: ${r.command}`);
    lines.push(`Cwd: ${r.cwd}`);
    if (r.cancelled) lines.push("Result: CANCELLED by user");
    else if (r.timedOut) lines.push("Result: TIMED OUT");
    else
        lines.push(`Exit: ${r.code}${r.signal ? ` (signal ${r.signal})` : ""}`);
    if (r.stdout) {
        lines.push("--- stdout ---");
        lines.push(r.stdout);
    }
    if (r.stderr) {
        lines.push("--- stderr ---");
        lines.push(r.stderr);
    }
    if (!r.stdout && !r.stderr) lines.push("(no output)");
    return lines.join("\n");
}
