import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface SystemInfo {
    platform: NodeJS.Platform;
    osName: string;
    osRelease: string;
    arch: string;
    shell: string;
    isWindows: boolean;
    isMac: boolean;
    isLinux: boolean;
    nodeVersion: string;
    cwd: string;
    homedir: string;
    workspaceFolders: string[];
    vscodeVersion: string;
}

let cached: SystemInfo | null = null;

export function systemInfo(): SystemInfo {
    if (cached) return cached;
    const platform = process.platform;
    cached = {
        platform,
        osName: prettyOs(platform),
        osRelease: os.release(),
        arch: os.arch(),
        shell: detectShell(platform),
        isWindows: platform === "win32",
        isMac: platform === "darwin",
        isLinux: platform === "linux",
        nodeVersion: process.version,
        cwd: workspaceCwd(),
        homedir: os.homedir(),
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
            (f) => f.uri.fsPath
        ),
        vscodeVersion: vscode.version,
    };
    return cached;
}

export function osOpenCommand(filePath: string): string {
    const s = systemInfo();
    const q = JSON.stringify(filePath);
    if (s.isWindows) return `cmd /c start "" ${q}`;
    if (s.isMac) return `open ${q}`;
    return `xdg-open ${q}`;
}

function workspaceCwd(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return ws ?? process.cwd();
}

function detectShell(platform: NodeJS.Platform): string {
    if (platform === "win32") {
        if (process.env.PSModulePath) return "powershell";
        if ((process.env.ComSpec ?? "").toLowerCase().endsWith("cmd.exe"))
            return "cmd";
        return "powershell";
    }
    const sh = process.env.SHELL || "";
    if (sh) return path.basename(sh);
    return "sh";
}

function prettyOs(platform: NodeJS.Platform): string {
    switch (platform) {
        case "win32":
            return "Windows";
        case "darwin":
            return "macOS";
        case "linux":
            return "Linux";
        case "freebsd":
            return "FreeBSD";
        default:
            return platform;
    }
}

export function systemBriefForLLM(): string {
    const s = systemInfo();
    const lines = [
        `Operating system: ${s.osName} ${s.osRelease} (${s.arch})`,
        `Shell: ${s.shell}`,
        `VS Code: ${s.vscodeVersion}`,
        `Node: ${s.nodeVersion}`,
        `Workspace: ${s.workspaceFolders.join(", ") || "(none)"}`,
        `cwd: ${s.cwd}`,
    ];
    if (s.isWindows) {
        lines.push(
            "Shell rules for Windows:",
            "- Do not chain commands with `||` or `&&` — PowerShell parses them differently than Unix shells.",
            "- Do not use `findstr` — it requires interactive console input. Prefer Select-String or the built-in `search` tool.",
            "- Do not use Unix tools (grep, sed, awk, cat) unless you know they are installed. Prefer the `search`, `read_file`, `list_dir`, `find_files` tools.",
            "- Avoid commands that open interactive prompts (pause, choice, more, pager)."
        );
    } else {
        lines.push(
            "- Avoid commands that open interactive prompts (less, more, pager)."
        );
    }
    return lines.join("\n");
}
