import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import { Logger } from "../../core/logger";

const CANDIDATES = {
    win32: [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Chromium/Application/chrome.exe",
    ],
    darwin: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    linux: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/usr/bin/microsoft-edge",
    ],
} as const;

function findBrowser(): string | null {
    const env = process.env.ONLYSQ_CHROME_PATH;
    if (env && fs.existsSync(env)) return env;
    const list = (CANDIDATES as any)[process.platform] || [];
    for (const p of list) if (fs.existsSync(p)) return p;
    return null;
}

export interface ScreenshotOpts {
    url: string;
    width?: number;
    height?: number;
    waitMs?: number;
    fullPage?: boolean;
}

export async function takeScreenshot(opts: ScreenshotOpts): Promise<{ dataUrl: string; bytes: number }> {
    const browser = findBrowser();
    if (!browser) {
        throw new Error("No headless browser found. Install Chrome/Chromium/Edge or set ONLYSQ_CHROME_PATH env var.");
    }
    const w = Math.max(100, Math.min(opts.width ?? 1280, 3840));
    const h = Math.max(100, Math.min(opts.height ?? 800, 2160));
    const wait = Math.max(0, Math.min(opts.waitMs ?? 1500, 30_000));
    const outPath = path.join(os.tmpdir(), `onlysq-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);

    const args = [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        `--window-size=${w},${h}`,
        `--virtual-time-budget=${wait}`,
        `--screenshot=${outPath}`,
    ];
    if (opts.fullPage) args.push("--full-page");
    args.push(opts.url);

    Logger.log(`[shot] ${browser} ${args.slice(0, 5).join(" ")} ... ${opts.url}`);
    await new Promise<void>((resolve, reject) => {
        const p = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        p.stderr.on("data", (d) => { stderr += d.toString(); });
        p.on("error", reject);
        const killer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error("screenshot timeout")); }, wait + 30_000);
        p.on("close", (code) => {
            clearTimeout(killer);
            if (code === 0 || fs.existsSync(outPath)) resolve();
            else reject(new Error(`browser exited ${code}: ${stderr.slice(0, 300)}`));
        });
    });

    if (!fs.existsSync(outPath)) throw new Error("screenshot file was not created");
    const buf = fs.readFileSync(outPath);
    try { fs.unlinkSync(outPath); } catch {}
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    return { dataUrl, bytes: buf.length };
}

export function fileToDataUrl(filePath: string): { dataUrl: string; bytes: number } {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
        : "image/png";
    return { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, bytes: buf.length };
}

export async function urlToDataUrl(url: string): Promise<{ dataUrl: string; bytes: number }> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "image/png";
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);
    return { dataUrl: `data:${ct};base64,${buf.toString("base64")}`, bytes: buf.length };
}
