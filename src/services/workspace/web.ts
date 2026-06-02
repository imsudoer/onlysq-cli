import { Logger } from "../../core/logger";

const MAX_BODY = 100_000;

export interface FetchResult {
    status: number;
    contentType: string;
    body: string;
    truncated: boolean;
}

export async function fetchUrl(
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; timeoutMs?: number }
): Promise<FetchResult> {
    const method = opts?.method ?? "GET";
    const timeout = Math.min(opts?.timeoutMs ?? 15_000, 30_000);
    Logger.log(`[web] ${method} ${url}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const resp = await fetch(url, {
            method,
            headers: opts?.headers,
            signal: controller.signal,
            redirect: "follow",
        });
        const ct = resp.headers.get("content-type") ?? "";
        let body: string;
        if (ct.includes("application/json")) {
            body = await resp.text();
        } else {
            body = await resp.text();
        }
        const truncated = body.length > MAX_BODY;
        return {
            status: resp.status,
            contentType: ct,
            body: truncated ? body.slice(0, MAX_BODY) : body,
            truncated,
        };
    } finally {
        clearTimeout(timer);
    }
}

export function stripHtml(html: string): string {
    // Remove scripts, styles, and their content
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
    text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
    text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
    // Replace block-level tags with newlines
    text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|br\s*\/?)>/gi, "\n");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    // Remove all remaining tags
    text = text.replace(/<[^>]+>/g, " ");
    // Decode common HTML entities
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, " ");
    // Clean up whitespace
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n[ \t]+/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
}

export async function scrapePage(url: string): Promise<string> {
    const result = await fetchUrl(url, { timeoutMs: 20_000 });
    if (result.status >= 400) {
        return `Error: HTTP ${result.status}`;
    }
    const text = stripHtml(result.body);
    const maxLen = 60_000;
    return text.length > maxLen ? text.slice(0, maxLen) + "\n\n…(truncated)" : text;
}

export async function webSearch(query: string, maxResults = 5): Promise<string> {
    // Use DuckDuckGo HTML search (no API key needed)
    const encoded = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
    Logger.log(`[web] search: ${query}`);

    try {
        const result = await fetchUrl(url, {
            timeoutMs: 10_000,
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; OnlySqCLI/1.0)",
            },
        });

        if (result.status >= 400) {
            return `Search failed: HTTP ${result.status}`;
        }

        // Parse DuckDuckGo HTML results
        const results: string[] = [];
        const re = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const hrefs: string[] = [];
        const titles: string[] = [];

        while ((match = re.exec(result.body)) !== null && hrefs.length < maxResults) {
            let href = match[1];
            // DuckDuckGo wraps URLs in redirect
            const udMatch = href.match(/uddg=([^&]+)/);
            if (udMatch) href = decodeURIComponent(udMatch[1]);
            hrefs.push(href);
            titles.push(match[2].replace(/<[^>]+>/g, "").trim());
        }

        const snippets: string[] = [];
        while ((match = snippetRe.exec(result.body)) !== null && snippets.length < maxResults) {
            snippets.push(match[1].replace(/<[^>]+>/g, "").trim());
        }

        for (let i = 0; i < hrefs.length; i++) {
            results.push(
                `${i + 1}. ${titles[i] || "(no title)"}\n   ${hrefs[i]}\n   ${snippets[i] || ""}`
            );
        }

        return results.length
            ? `Search results for "${query}":\n\n${results.join("\n\n")}`
            : `No results found for "${query}".`;
    } catch (e: any) {
        return `Search error: ${e?.message ?? e}`;
    }
}
