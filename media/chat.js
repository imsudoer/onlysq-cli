(function () {
    "use strict";

    const vscode = acquireVsCodeApi();
    window.__vscode = vscode;

    const $ = (id) => document.getElementById(id);

    function log() {
        try {
            const a = Array.prototype.slice.call(arguments);
            console.log.apply(console, ["[chat]"].concat(a));
            vscode.postMessage({
                type: "__log",
                args: a.map((x) => {
                    try {
                        return typeof x === "string" ? x : JSON.stringify(x);
                    } catch {
                        return String(x);
                    }
                }),
            });
        } catch (e) {}
    }
    window.addEventListener("error", (e) =>
        log("error", e.message, e.filename + ":" + e.lineno)
    );

    const logEl = $("logEl");
    const logBody = $("logBody");
    const inp = $("inp");
    const composer = $("composer");
    const composerWrap = $("composerWrap");
    const composerResizer = $("composerResizer");
    const sendBtn = $("sendBtn");
    const stopBtn = $("stopBtn");
    const agentBtn = $("agentToggle");
    const newBtn = $("newChat");
    const modelPill = $("modelPill");
    const modelLabel = $("modelLabel");
    const authPanel = $("authPanel");
    const authError = $("authError");
    const authBtn = $("authBtn");
    const authSub = $("authSub");
    const modalBackdrop = $("modelModal");
    const modelSearch = $("modelSearch");
    const modelList = $("modelList");
    const loadMoreWrap = $("loadMoreWrap");
    const loadMoreBtn = $("loadMoreBtn");
    const chatHeader = $("chatHeader");
    const chatsBtn = $("chatsBtn");
    const chatsPanel = $("chatsPanel");
    const chatsList = $("chatsList");
    const chatsSearch = $("chatsSearch");
    const chatsNewBtn = $("chatsNewBtn");
    const chatTitleEl = $("chatTitle");
    const HISTORY_WINDOW = 30;
    const pauseBtn = $("pauseBtn");
    const settingsBtn = $("settingsBtn");
    const settingsPanel = $("settingsPanel");
    const settingsClose = $("settingsClose");
    const settingsBody = $("settingsBody");
    const exportBtn = $("exportBtn");
    const exportMenu = $("exportMenu");
    const mentionPopup = $("mentionPopup");
    const dropOverlay = $("dropOverlay");
    const attachedFilesEl = $("attachedFiles");

    let mode = "chat";
    let currentBody = null;
    let currentAcc = "";
    let streaming = false;
    let signedIn = false;
    let currentModel = "";
    let models = [];
    let toolBlocks = new Map(); // id -> element
    let statusPill = null;
    let chatsState = { list: [], activeId: null };
    let chatsQuery = "";
    let canLoadMore = false;
    let isLoadingMore = false;
    let paused = false;
    let stickToBottom = true;
    let scrollBtn = null;
    let userScrolling = false;
    let userScrollEndTimer;
    let scrollTrimDebounce;
    let mentionActive = false;
    let mentionStart = -1;
    let mentionIdx = 0;
    let mentionItems = [];
    let attachedFiles = []; // {name, path, content}
    let pendingEditIds = []; // for multi-diff
    let lastAppliedEditId = null; // for undo

    let savedHeight =
        parseInt(localStorage.getItem("onlysq.composerH") || "0", 10) || 0;

    function el(tag, cls, parent) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (parent) parent.appendChild(e);
        return e;
    }
    function show(elx, visible) {
        if (elx) elx.style.display = visible ? "" : "none";
    }
    function scrollToBottom() {
        logEl.scrollTop = logEl.scrollHeight;
    }

    function escapeHtml(s) {
        return String(s).replace(
            /[&<>"']/g,
            (c) =>
                ({
                    "&": "&" + "amp;",
                    "<": "&" + "lt;",
                    ">": "&" + "gt;",
                    '"': "&" + "quot;",
                    "'": "&" + "#39;",
                }[c])
        );
    }

    function setStreaming(b) {
        streaming = b;
        logEl.classList.toggle("streaming", b);
        if (b) {
            sendBtn.style.display = "none";
            stopBtn.style.display = "";
            if (pauseBtn) pauseBtn.style.display = mode === "agent" ? "" : "none";
        } else {
            sendBtn.style.display = "";
            stopBtn.style.display = "none";
            if (pauseBtn) pauseBtn.style.display = "none";
            setPaused(false);
        }
        updateSendActive();
    }
    function updateSendActive() {
        const hasText = inp.value.trim().length > 0;
        sendBtn.classList.toggle("active", hasText && signedIn);
        sendBtn.disabled = !signedIn || !hasText;
    }

    function finalizeCurrent() {
        if (currentBody) {
            currentBody.classList.remove("cursor");
            const msg = currentBody.closest(".msg");
            if (msg && !currentAcc.trim()) msg.remove();
        }
        currentBody = null;
        currentAcc = "";
    }
    function startAssistantBody() {
        finalizeCurrent();
        currentAcc = "";
        currentBody = addMsg("assistant", "");
        currentBody.classList.add("cursor");
        return currentBody;
    }

    function setAuth(state) {
        signedIn = !!state.signed;
        const busy = !!state.signingIn;
        show(authPanel, !signedIn);
        show(logEl, signedIn);
        show(composerWrap, signedIn);
        show(chatHeader, signedIn);
        if (!signedIn) {
            authBtn.disabled = busy;
            authBtn.textContent = busy ? "Signing in…" : "Auth with OnlySq";
            authSub.textContent = busy
                ? "A browser tab was opened. Approve the request to continue."
                : "Sign in with your OnlySq account to use chat, completions and the agent.";
            show(authError, !!state.error);
            if (state.error) authError.textContent = state.error;
            return;
        }
        show(authError, false);
        if (!logBody.children.length) renderEmpty();
        updateSendActive();
    }

    function setMode(m) {
        mode = m;
        agentBtn.classList.toggle("on", m === "agent");
        agentBtn.title =
            m === "agent"
                ? "Agent mode: ON (file edits enabled)"
                : "Agent mode: OFF";
    }

    function setModel(id, list) {
        if (list) models = list;
        currentModel = id || currentModel;
        modelLabel.textContent = currentModel || "Select model";
    }

    const BT = String.fromCharCode(96);
    const fenceRe = new RegExp(
        BT + BT + BT + "(\\w*)\\n([\\s\\S]*?)" + BT + BT + BT,
        "g"
    );
    const inlineRe = new RegExp(BT + "([^" + BT + "\\n]+)" + BT, "g");

    // Extract <thinking> blocks for reasoning display
    var thinkingRe = /<thinking>([\s\S]*?)<\/thinking>/gi;

    function renderMarkdown(text) {
        if (!text) return "";
        // Render thinking blocks first
        var thinkingBlocks = "";
        text = text.replace(thinkingRe, function(_, content) {
            thinkingBlocks += '<div class="reasoning-block">' +
                '<div class="reasoning-head" onclick="this.parentElement.classList.toggle(\'open\')">' +
                '<span class="r-arrow">\u25B6</span> <span>Thinking\u2026</span></div>' +
                '<div class="reasoning-body">' + escapeHtml(content.trim()) + '</div></div>';
            return '';
        });
        if (!text.trim() && thinkingBlocks) return thinkingBlocks;
        let out = "";
        let last = 0;
        const re = new RegExp(fenceRe);
        let m;
        while ((m = re.exec(text)) !== null) {
            out += renderProse(text.slice(last, m.index));
            const lang = m[1] || "";
            const code = m[2];
            const langLabel = lang ? escapeHtml(lang) : "code";
            const escapedCode = escapeHtml(code);
            out +=
                '<div class="code-block-wrap">' +
                '<div class="code-block-header">' +
                '<span class="code-lang">' + langLabel + '</span>' +
                '<button class="code-copy-btn" data-code="' + escapedCode.replace(/"/g, '&quot;') + '">Copy</button>' +
                '</div>' +
                '<pre><code class="lang-' +
                escapeHtml(lang) +
                '">' +
                highlightCode(code, lang) +
                "</code></pre></div>";
            last = m.index + m[0].length;
        }
        out += renderProse(text.slice(last));
        return thinkingBlocks + out;
    }
    function renderProse(text) {
        if (!text) return "";
        const blocks = text.split(/\n\s*\n/);
        return blocks.map(renderBlock).filter(Boolean).join("");
    }
    function renderBlock(block) {
        const trimmed = block.replace(/^\n+|\n+$/g, "");
        if (!trimmed) return "";
        const h = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
        if (h && trimmed.indexOf("\n") === -1) {
            const level = h[1].length;
            return (
                "<h" + level + ">" + renderInlineMd(h[2]) + "</h" + level + ">"
            );
        }
        const lines = trimmed.split("\n");
        // Table detection
        if (lines.length >= 2 && /^\|/.test(lines[0]) && /^[\|\s:-]+$/.test(lines[1])) {
            return renderTable(lines);
        }
        if (lines.every((l) => /^\s*[-*+]\s+/.test(l) || /^\s+/.test(l))) {
            return renderList(lines, false);
        }
        if (lines.every((l) => /^\s*\d+\.\s+/.test(l) || /^\s+/.test(l))) {
            return renderList(lines, true);
        }
        if (lines.every((l) => /^\s*>/.test(l))) {
            const inner = lines
                .map((l) => l.replace(/^\s*>\s?/, ""))
                .join("\n");
            return "<blockquote>" + renderProse(inner) + "</blockquote>";
        }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return "<hr/>";
        return "<p>" + renderInlineMd(trimmed.replace(/\n/g, " ")) + "</p>";
    }
    function renderTable(lines) {
        var headerCells = lines[0].split("|").map(function(c) { return c.trim(); }).filter(Boolean);
        var rows = [];
        for (var i = 2; i < lines.length; i++) {
            if (!lines[i].trim() || !/^\|/.test(lines[i])) break;
            rows.push(lines[i].split("|").map(function(c) { return c.trim(); }).filter(Boolean));
        }
        var html = "<table><thead><tr>";
        headerCells.forEach(function(c) { html += "<th>" + renderInlineMd(c) + "</th>"; });
        html += "</tr></thead><tbody>";
        rows.forEach(function(row) {
            html += "<tr>";
            row.forEach(function(c) { html += "<td>" + renderInlineMd(c) + "</td>"; });
            html += "</tr>";
        });
        html += "</tbody></table>";
        return html;
    }
    function renderList(lines, ordered) {
        const tag = ordered ? "ol" : "ul";
        const items = [];
        let cur = null;
        for (const l of lines) {
            const m = l.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
            if (m) {
                if (cur != null) items.push(cur);
                cur = m[1];
            } else if (cur != null) {
                cur += " " + l.trim();
            }
        }
        if (cur != null) items.push(cur);
        return (
            "<" +
            tag +
            ">" +
            items.map((i) => "<li>" + renderInlineMd(i) + "</li>").join("") +
            "</" +
            tag +
            ">"
        );
    }
    function renderInlineMd(text) {
        const tokens = [];
        let s = String(text).replace(inlineRe, (_, code) => {
            tokens.push("<code>" + escapeHtml(code) + "</code>");
            return "\u0000" + (tokens.length - 1) + "\u0000";
        });
        s = escapeHtml(s);
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
            const safe = /^(https?:|mailto:)/i.test(url) ? url : "#";
            return (
                '<a href="' +
                safe +
                '" target="_blank" rel="noopener">' +
                label +
                "</a>"
            );
        });
        s = s.replace(
            /(^|[\s(])((?:https?:\/\/)[^\s<>"')]+)/g,
            (m, pre, url) =>
                pre +
                '<a href="' +
                url +
                '" target="_blank" rel="noopener">' +
                url +
                "</a>"
        );
        s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
        s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
        s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[+i]);
        return s;
    }

    const KEYWORDS = new Set([
        "function",
        "const",
        "let",
        "var",
        "if",
        "else",
        "for",
        "while",
        "return",
        "class",
        "new",
        "import",
        "from",
        "export",
        "default",
        "async",
        "await",
        "try",
        "catch",
        "throw",
        "typeof",
        "instanceof",
        "in",
        "of",
        "this",
        "super",
        "extends",
        "static",
        "public",
        "private",
        "protected",
        "interface",
        "type",
        "enum",
        "true",
        "false",
        "null",
        "undefined",
        "void",
        "any",
        "never",
        "def",
        "elif",
        "None",
        "True",
        "False",
        "lambda",
        "pass",
        "yield",
        "with",
        "as",
        "print",
        "package",
        "func",
        "struct",
        "impl",
        "fn",
        "use",
        "mut",
        "pub",
        "crate",
    ]);
    function highlightCode(code) {
        const esc = escapeHtml(code);
        return esc.replace(
            /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)/g,
            (m, str, com, num, word) => {
                if (str) return '<span class="tok-str">' + str + "</span>";
                if (com) return '<span class="tok-com">' + com + "</span>";
                if (num) return '<span class="tok-num">' + num + "</span>";
                if (word) {
                    if (KEYWORDS.has(word))
                        return '<span class="tok-kw">' + word + "</span>";
                    if (/^[A-Z]/.test(word))
                        return '<span class="tok-type">' + word + "</span>";
                }
                return m;
            }
        );
    }

    function estimateTokens(text) {
        if (!text) return 0;
        // Rough estimate: ~4 chars per token for English, ~2 for code
        return Math.round(text.length / 3.5);
    }

    function renderEmpty() {
        logBody.innerHTML = "";
        const e = el("div", "empty", logBody);
        e.innerHTML =
            '<div class="empty-logo"><span>Sq</span><span class="dot">.</span></div>' +
            '<div class="empty-sub">Ask about your code, or switch to Agent mode for file edits.</div>' +
            '<div class="suggestions">' +
            '<button data-q="Explain this file">Explain this file</button>' +
            '<button data-q="Find bugs in the selected code">Find bugs in selection</button>' +
            '<button data-q="Add doc comments to all functions in this file">Add doc comments</button>' +
            '<button data-q="Refactor for readability">Refactor for readability</button>' +
            "</div>";
        e.querySelectorAll("button[data-q]").forEach((b) => {
            b.addEventListener("click", () => {
                inp.value = b.dataset.q;
                autoSize();
                send();
            });
        });
    }

    function addMsg(role, text, prepend) {
        const empty = logBody.querySelector(".empty");
        if (empty) empty.remove();
        const m = document.createElement("div");
        m.className = "msg " + role + " new-msg";
        setTimeout(function() { m.classList.remove("new-msg"); }, 200);

        const head = el("div", "msg-head", m);
        const r = el("span", "role", head);
        r.textContent = role === "user" ? "You" : "OnlySq";

        const actions = el("span", "msg-actions", head);
        if (role === "user") {
            const editBtn = el("button", "msg-action", actions);
            editBtn.textContent = "Edit";
            editBtn.title = "Edit and resend";
            editBtn.addEventListener("click", () => beginEdit(m));
        } else {
            const regenBtn = el("button", "msg-action", actions);
            regenBtn.textContent = "Regenerate";
            regenBtn.title = "Regenerate from this message";
            regenBtn.addEventListener("click", () => requestRegenerate(m));
        }
        const copyBtn = el("button", "msg-action", actions);
        copyBtn.textContent = "Copy";
        copyBtn.title = "Copy text";
        copyBtn.addEventListener("click", () => copyText(m));

        if (text && text.length > 10) {
            var tokSpan = el("span", "msg-tokens", head);
            tokSpan.textContent = "\u2248" + estimateTokens(text) + " tok";
        }

        const body = el("div", "body", m);
        body.innerHTML = renderMarkdown(text);
        m.dataset.raw = text;

        if (prepend) logBody.insertBefore(m, logBody.firstChild);
        else logBody.appendChild(m);
        if (!prepend) scrollToBottom();
        return body;
    }

    function visibleIndexOf(msgEl) {
        const all = Array.from(logBody.querySelectorAll(".msg"));
        return all.indexOf(msgEl);
    }

    function copyText(msgEl) {
        const raw =
            msgEl.dataset.raw || msgEl.querySelector(".body")?.innerText || "";
        try {
            navigator.clipboard.writeText(raw);
            flashAction(msgEl, "Copied");
        } catch (e) {}
    }

    function flashAction(msgEl, text) {
        const head = msgEl.querySelector(".msg-head");
        if (!head) return;
        const flash = el("span", "msg-flash", head);
        flash.textContent = text;
        setTimeout(() => flash.remove(), 1200);
    }

    function requestRegenerate(msgEl) {
        if (streaming) return;
        const idx = visibleIndexOf(msgEl);
        if (idx < 0) return;
        vscode.postMessage({ type: "regenerateAt", index: idx, mode });
    }

    function beginEdit(msgEl) {
        if (streaming) return;
        if (msgEl.classList.contains("editing")) return;
        msgEl.classList.add("editing");
        const body = msgEl.querySelector(".body");
        const raw = msgEl.dataset.raw || body.innerText || "";
        body.innerHTML = "";

        const ta = document.createElement("textarea");
        ta.className = "msg-editor";
        ta.value = raw;
        ta.rows = Math.min(10, Math.max(2, raw.split("\n").length));
        body.appendChild(ta);

        const ctl = el("div", "msg-editor-actions", body);
        const save = el("button", "btn primary small", ctl);
        save.textContent = "Save & resend";
        const cancel = el("button", "btn ghost small", ctl);
        cancel.textContent = "Cancel";

        setTimeout(() => {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }, 20);

        function finish(commit) {
            const next = ta.value;
            msgEl.classList.remove("editing");
            if (commit && next.trim()) {
                const idx = visibleIndexOf(msgEl);
                vscode.postMessage({
                    type: "editMessage",
                    index: idx,
                    text: next,
                    mode,
                });
            } else {
                body.innerHTML = renderMarkdown(raw);
            }
        }
        save.addEventListener("click", () => finish(true));
        cancel.addEventListener("click", () => finish(false));
        ta.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                finish(true);
            }
            if (e.key === "Escape") {
                e.preventDefault();
                finish(false);
            }
        });
    }

    function renderHistoryMessages(messages, prepend) {
        const empty = logBody.querySelector(".empty");
        if (empty && messages.length) empty.remove();
        if (prepend) {
            for (let i = messages.length - 1; i >= 0; i--) {
                renderHistoryMessage(messages[i], true);
            }
        } else {
            for (const m of messages) renderHistoryMessage(m, false);
        }
    }

    settingsBtn.addEventListener("click", () => {
        showSettings(true);
        vscode.postMessage({ type: "getSettings" });
        settingsPanel.classList.add("anim-in");
        setTimeout(() => settingsPanel.classList.remove("anim-in"), 250);
    });
    settingsClose.addEventListener("click", () => showSettings(false));

    function renderSettings(state) {
        const { profile, values } = state;
        settingsBody.innerHTML = "";

        const account = el("section", "card", settingsBody);
        account.innerHTML = '<div class="card-title">Account</div>';
        const rows = el("div", "rows", account);
        [
            ["Name", profile.name],
            ["Email", profile.email],
            ["ID", profile.id],
            ["Level", profile.level],
            ["Balance", profile.balance != null ? "$" + profile.balance : null],
        ].forEach(([k, v]) => {
            const row = el("div", "row", rows);
            row.innerHTML =
                '<span class="k">' +
                k +
                "</span>" +
                '<span class="v">' +
                (v == null ? "—" : escapeHtml(String(v))) +
                "</span>";
        });
        const actions = el("div", "actions", account);
        const dashBtn = el("button", "btn ghost small", actions);
        dashBtn.textContent = "Open dashboard";
        dashBtn.addEventListener("click", () =>
            vscode.postMessage({ type: "openDashboard" })
        );
        const signOutBtn = el("button", "btn ghost small", actions);
        signOutBtn.textContent = "Sign out";
        signOutBtn.addEventListener("click", () =>
            vscode.postMessage({ type: "signOut" })
        );

        const ai = el("section", "card", settingsBody);
        ai.innerHTML = '<div class="card-title">AI</div>';
        settingRow(ai, "Chat model", "chatModel", values, "string-model");
        settingRow(
            ai,
            "Completion model",
            "completionModel",
            values,
            "string-model"
        );
        settingRow(
            ai,
            "Inline completions",
            "inlineCompletions.enabled",
            values,
            "bool"
        );
        settingRow(ai, "Temperature", "temperature", values, "number", {
            min: 0,
            max: 2,
            step: 0.1,
        });

        const agent = el("section", "card", settingsBody);
        agent.innerHTML = '<div class="card-title">Agent</div>';
        settingRow(agent, "Max steps", "agent.maxSteps", values, "number", {
            min: 1,
            max: 200,
            step: 1,
        });
        settingRow(
            agent,
            "Parallel tools",
            "agent.parallelTools",
            values,
            "bool"
        );
        settingRow(agent, "Cache reads", "agent.toolCache", values, "bool");
        settingRow(
            agent,
            "Persist chat history",
            "chat.persistHistory",
            values,
            "bool"
        );
        settingRow(
            agent,
            "Personalization",
            "agent.personalization",
            values,
            "bool"
        );
        settingRow(
            agent,
            "Custom system prompt",
            "agent.customSystemPrompt",
            values,
            "textarea"
        );

        const approval = el("section", "card", settingsBody);
        approval.innerHTML = '<div class="card-title">Tool Policy</div>' +
            '<div class="small muted" style="margin-bottom:8px">Per-tool: always (auto-approve) / ask (prompt) / never (deny) / disabled (hide from agent)</div>';
        var policy = values["agent.toolPolicy"] || {};
        var toolGroups = {
            "Read-only": ["read_file","list_dir","list_tree","search","find_files","file_info","find_in_file",
                "open_file","goto_position","get_cursor","get_selection","list_open_files","get_diagnostics",
                "list_tasks","git_status","git_diff","workspace_info","system_info"],
            "File edits": ["propose_edit","apply_at_line","replace_in_file","patch_file","delete_file","rename_file"],
            "Shell / commands": ["run_command","run_command_interactive","run_task","run_vscode_command","open_in_browser","git_commit"],
            "Web": ["fetch_url","web_search","scrape_page"],
            "Meta": ["pause_agent","ask_user","delegate"],
        };
        Object.entries(toolGroups).forEach(function(entry) {
            var groupName = entry[0], toolNames = entry[1];
            var sub = el("div", "", approval);
            sub.style.marginBottom = "8px";
            var subTitle = el("div", "small muted", sub);
            subTitle.style.fontWeight = "600";
            subTitle.style.marginBottom = "4px";
            subTitle.textContent = groupName;
            toolNames.forEach(function(tn) {
                var row = el("div", "setting-row", sub);
                row.style.padding = "2px 0";
                var lab = el("label", "setting-label", row);
                lab.textContent = tn;
                lab.style.fontSize = "11px";
                lab.style.fontFamily = "var(--vscode-editor-font-family)";
                var ctl = el("div", "setting-control", row);
                var sel = document.createElement("select");
                sel.className = "setting-input";
                sel.style.fontSize = "10px";
                sel.style.padding = "1px 4px";
                var cur = policy[tn] || "";
                ["always","ask","never","disabled"].forEach(function(v) {
                    var o = document.createElement("option");
                    o.value = v;
                    o.textContent = v;
                    if (v === cur) o.selected = true;
                    sel.appendChild(o);
                });
                ctl.appendChild(sel);
                sel.addEventListener("change", function() {
                    var updated = Object.assign({}, policy);
                    updated[tn] = sel.value;
                    policy = updated;
                    vscode.postMessage({ type: "setSetting", key: "agent.toolPolicy", value: updated });
                });
            });
        });

        const diag = el("section", "card", settingsBody);
        diag.innerHTML = '<div class="card-title">Diagnostics</div>';
        const dactions = el("div", "actions", diag);
        const logBtn = el("button", "btn ghost small", dactions);
        logBtn.textContent = "Show log";
        logBtn.addEventListener("click", () =>
            vscode.postMessage({ type: "showLog" })
        );
    }

    function settingRow(parent, label, key, values, kind, opts) {
        const row = el("div", "setting-row", parent);
        const lab = el("label", "setting-label", row);
        lab.textContent = label;
        const ctl = el("div", "setting-control", row);

        const current = values[key];
        if (kind === "bool") {
            const sw = el("label", "switch", ctl);
            const inp = document.createElement("input");
            inp.type = "checkbox";
            inp.checked = !!current;
            sw.appendChild(inp);
            const slider = el("span", "slider", sw);
            inp.addEventListener("change", () => {
                vscode.postMessage({
                    type: "setSetting",
                    key,
                    value: inp.checked,
                });
            });
        } else if (kind === "number") {
            const inp = document.createElement("input");
            inp.type = "number";
            inp.className = "setting-input";
            if (opts) {
                if (opts.min != null) inp.min = String(opts.min);
                if (opts.max != null) inp.max = String(opts.max);
                if (opts.step != null) inp.step = String(opts.step);
            }
            inp.value = String(current ?? "");
            ctl.appendChild(inp);
            inp.addEventListener("change", () => {
                vscode.postMessage({
                    type: "setSetting",
                    key,
                    value: Number(inp.value),
                });
            });
        } else if (kind === "enum-approval") {
            const sel = document.createElement("select");
            sel.className = "setting-input";
            ["always", "ask", "never"].forEach((v) => {
                const o = document.createElement("option");
                o.value = v;
                o.textContent = v;
                if (v === current) o.selected = true;
                sel.appendChild(o);
            });
            ctl.appendChild(sel);
            sel.addEventListener("change", () => {
                vscode.postMessage({
                    type: "setSetting",
                    key,
                    value: sel.value,
                });
            });
        } else if (kind === "string-model") {
            const wrap = el("div", "model-pill", ctl);
            wrap.style.minWidth = "120px";
            const label = el("span", "", wrap);
            label.textContent = current || "—";
            const caret = el("span", "pcaret", wrap);
            caret.textContent = "▾";
            wrap.addEventListener("click", () => {
                settingsModelTarget = key;
                modalBackdrop.classList.add("open");
                modelSearch.value = "";
                renderModels("");
                setTimeout(() => modelSearch.focus(), 20);
            });
        } else if (kind === "textarea") {
            var ta = document.createElement("textarea");
            ta.className = "setting-input";
            ta.style.width = "100%";
            ta.style.minHeight = "50px";
            ta.style.resize = "vertical";
            ta.value = String(current ?? "");
            ta.placeholder = "Enter custom instructions...";
            ctl.appendChild(ta);
            ta.addEventListener("change", function() {
                vscode.postMessage({ type: "setSetting", key: key, value: ta.value });
            });
        } else if (kind === "textarea-list") {
            var ta2 = document.createElement("textarea");
            ta2.className = "setting-input";
            ta2.style.width = "100%";
            ta2.style.minHeight = "40px";
            ta2.style.resize = "vertical";
            ta2.value = Array.isArray(current) ? current.join(", ") : String(current ?? "");
            ta2.placeholder = "run_command, delete_file, ...";
            ctl.appendChild(ta2);
            var hint = el("div", "small muted", ctl);
            hint.textContent = "Comma-separated tool names to disable";
            hint.style.marginTop = "2px";
            ta2.addEventListener("change", function() {
                var arr = ta2.value.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
                vscode.postMessage({ type: "setSetting", key: key, value: arr });
            });
        }
    }

    let settingsModelTarget = null;

    function renderHistoryMessage(m, prepend) {
        if (m.role === "user") {
            addMsg("user", m.content, prepend);
            return;
        }
        if (m.role === "assistant") {
            if (prepend) {
                const tools = m.tools || [];
                for (let i = tools.length - 1; i >= 0; i--) {
                    const t = tools[i];
                    addHistoricalTool(t, true);
                }
                if (m.content) addMsg("assistant", m.content, true);
            } else {
                if (m.content) addMsg("assistant", m.content, false);
                for (const t of m.tools || []) {
                    addHistoricalTool(t, false);
                }
            }
            return;
        }
    }

    function addHistoricalTool(t, prepend) {
        const isFile = FILE_TOOLS.has(t.name);
        const block = document.createElement("div");
        block.className = "tool-block" + (isFile ? " file" : "");
        block.dataset.id = t.id;
        const summary = summarizeArgs(t.name, t.args);

        const head = el("div", "tool-head", block);
        head.innerHTML =
            '<span class="tcheck">✓</span>' +
            '<span class="tname">' +
            escapeHtml(t.name) +
            "</span>" +
            '<span class="tmeta' +
            (isFile ? " tfile" : "") +
            '">' +
            escapeHtml(summary) +
            "</span>" +
            '<span class="tarrow">▶</span>';

        const body = el("div", "tool-body", block);
        if (
            t.args &&
            typeof t.args.reason === "string" &&
            t.args.reason.trim()
        ) {
            const reasonBlock = el("div", "", body);
            reasonBlock.innerHTML =
                '<div class="tlabel">Description</div>' +
                '<div class="treason"></div>';
            reasonBlock.querySelector(".treason").textContent = t.args.reason;
        }

        const argsBlock = el("div", "", body);
        argsBlock.innerHTML =
            '<div class="tlabel">Arguments</div>' +
            '<div class="targs">' +
            highlightCode(JSON.stringify(t.args, null, 2)) +
            "</div>";

        if (typeof t.result === "string") {
            const r = el("div", "", body);
            r.innerHTML =
                '<div class="tlabel">Result</div><div class="tresult"></div>';
            r.querySelector(".tresult").textContent =
                t.result.length > 4000
                    ? t.result.slice(0, 4000) + "\n…(truncated)"
                    : t.result;
        }

        head.addEventListener("click", () => block.classList.toggle("open"));

        if (prepend) logBody.insertBefore(block, logBody.firstChild);
        else logBody.appendChild(block);

        toolBlocks.set(t.id, block);
    }

    function clearStatusPill() {
        if (statusPill) {
            statusPill.remove();
            statusPill = null;
        }
    }
    function showStatusPill(text) {
        clearStatusPill();
        statusPill = el("div", "status-pill", logBody);
        var dots = el("div", "status-dots", statusPill);
        el("span", "", dots);
        el("span", "", dots);
        el("span", "", dots);
        var label = el("span", "stext", statusPill);
        label.textContent = text;
        scrollToBottom();
    }

    function renderAskUser(id, question, options, multiSelect) {
        const wrap = el("div", "ask-user-block", logBody);
        wrap.dataset.id = id;

        const q = el("div", "ask-question", wrap);
        q.innerHTML = renderMarkdown(question);

        if (options && options.length) {
            const form = el("div", "ask-options", wrap);
            const type = multiSelect ? "checkbox" : "radio";
            const selected = new Set();

            options.forEach(function (opt) {
                const label = el("label", "ask-option", form);
                const cb = document.createElement("input");
                cb.type = type;
                cb.name = "ask-" + id;
                cb.value = opt;
                label.appendChild(cb);
                const span = el("span", "", label);
                span.textContent = opt;
                cb.addEventListener("change", function () {
                    if (multiSelect) {
                        if (cb.checked) selected.add(opt);
                        else selected.delete(opt);
                    } else {
                        selected.clear();
                        selected.add(opt);
                    }
                    submitBtn.disabled = selected.size === 0;
                });
            });

            const actions = el("div", "ask-actions", wrap);
            var submitBtn = el("button", "btn primary small", actions);
            submitBtn.textContent = "Reply";
            submitBtn.disabled = true;
            submitBtn.addEventListener("click", function () {
                var answer = Array.from(selected).join(", ");
                submitAnswer(id, answer, wrap);
            });
        } else {
            var inputWrap = el("div", "ask-input-wrap", wrap);
            var ta = document.createElement("textarea");
            ta.className = "ask-input";
            ta.rows = 2;
            ta.placeholder = "Type your answer\u2026";
            inputWrap.appendChild(ta);

            var actions2 = el("div", "ask-actions", wrap);
            var submitBtn2 = el("button", "btn primary small", actions2);
            submitBtn2.textContent = "Reply";
            submitBtn2.disabled = true;
            ta.addEventListener("input", function () {
                submitBtn2.disabled = !ta.value.trim();
            });
            ta.addEventListener("keydown", function (e) {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (ta.value.trim()) submitAnswer(id, ta.value.trim(), wrap);
                }
            });
            submitBtn2.addEventListener("click", function () {
                if (ta.value.trim()) submitAnswer(id, ta.value.trim(), wrap);
            });

            setTimeout(function () { ta.focus(); }, 20);
        }

        scrollToBottom();
    }

    function submitAnswer(id, answer, wrap) {
        vscode.postMessage({ type: "answerUser", id: id, answer: answer });
        wrap.innerHTML = "";
        wrap.className = "ask-user-answered";
        var badge = el("div", "ask-answered-badge", wrap);
        badge.innerHTML =
            '<span class="ask-check">\u2713</span> <span>Answered: ' +
            escapeHtml(answer) +
            "</span>";
    }

    const FILE_TOOLS = new Set([
        "read_file",
        "write_file",
        "open_file",
        "propose_edit",
        "apply_at_line",
        "patch_file",
        "replace_in_file",
        "find_in_file",
    ]);
    const EDIT_TOOLS = new Set([
        "propose_edit",
        "apply_at_line",
        "patch_file",
        "replace_in_file",
    ]);
    const TOOL_LABELS = {
        read_file: "Reading",
        write_file: "Writing",
        propose_edit: "Editing",
        apply_at_line: "Editing",
        patch_file: "Patching",
        replace_in_file: "Editing",
        find_in_file: "Searching",
        open_file: "Opening",
        list_dir: "Listing",
        list_tree: "Listing",
        search: "Searching",
        get_selection: "Reading selection",
        run_command: "Running",
        run_command_interactive: "Starting",
        git_status: "Git status",
        git_diff: "Git diff",
        delegate: "Delegating to",
        pause_agent: "Pausing",
        ask_user: "Asking",
        fetch_url: "Fetching",
        web_search: "Searching web",
        scrape_page: "Scraping",
        git_commit: "Committing",
        add_memory: "Remembering",
        get_memory: "Recalling",
        view_memories: "Listing memories",
        delete_memory: "Forgetting",
    };

    function summarizeArgs(name, args) {
        try {
            if (name === "delegate") {
                return args?.agent ? args.agent + ": " + (args.goal || "").slice(0, 60) : "(unknown)";
            }
            if (name === "ask_user") return args?.question ? args.question.slice(0, 60) : "(question)";
            if (name === "pause_agent") return args?.reason ? args.reason.slice(0, 60) : "(pause)";
            if (name === "fetch_url" || name === "scrape_page") return args?.url || "";
            if (name === "web_search") return args?.query || "";
            if (name === "git_commit") return args?.message ? args.message.slice(0, 60) : "";
            if (name === "add_memory") return args?.key ? args.key + " = " + (args.value || "").slice(0, 40) : "";
            if (name === "get_memory" || name === "delete_memory") return args?.key || "";
            if (name === "view_memories") return args?.query || "(all)";
            if (FILE_TOOLS.has(name) && args && args.path) {
                if (name === "apply_at_line") {
                    const r =
                        args.start_line +
                        (args.end_line ? `-${args.end_line}` : "");
                    return `${args.path}:${r}`;
                }
                if (name === "replace_in_file") {
                    const ops = Array.isArray(args.operations)
                        ? args.operations.length
                        : 0;
                    return `${args.path} (${ops} op${ops === 1 ? "" : "s"})`;
                }
                return args.path;
            }
            if (name === "list_dir") return (args && args.path) || ".";
            if (name === "search")
                return "/" + ((args && args.pattern) || "") + "/";
            if (name === "find_in_file")
                return `${args?.path || ""} /${args?.pattern || ""}/`;
            if (name === "get_selection") return "(active editor)";
            const s = JSON.stringify(args);
            return s.length > 80 ? s.slice(0, 80) + "…" : s;
        } catch {
            return "";
        }
    }

    function describeTool(name, args) {
        const verb = TOOL_LABELS[name] || name;
        if (FILE_TOOLS.has(name) && args && args.path)
            return verb + " " + args.path;
        if (name === "list_dir")
            return verb + " " + ((args && args.path) || ".");
        if (name === "search")
            return verb + " /" + ((args && args.pattern) || "") + "/";
        return verb + "…";
    }

    function addToolBlock(id, name, args) {
        const isFile = FILE_TOOLS.has(name);
        const block = el(
            "div",
            "tool-block" + (isFile ? " file" : ""),
            logBody
        );
        block.dataset.id = id;
        const summary = summarizeArgs(name, args);

        const head = el("div", "tool-head", block);
        head.innerHTML =
            '<span class="tspinner"></span>' +
            '<span class="tname">' +
            escapeHtml(name) +
            "</span>" +
            '<span class="tmeta' +
            (isFile ? " tfile" : "") +
            '">' +
            escapeHtml(summary) +
            "</span>" +
            '<span class="tarrow">▶</span>';

        if (args && typeof args.reason === "string" && args.reason.trim()) {
            const reasonLine = el("div", "tool-reason", block);
            reasonLine.textContent = args.reason.trim();
        }

        const body = el("div", "tool-body", block);
        const argsBlock = el("div", "", body);
        argsBlock.innerHTML =
            '<div class="tlabel">Arguments</div>' +
            '<div class="targs">' +
            highlightCode(JSON.stringify(args, null, 2)) +
            "</div>";

        head.addEventListener("click", () => block.classList.toggle("open"));

        toolBlocks.set(id, block);
        showStatusPill(describeTool(name, args));
        scrollToBottom();
        return block;
    }

    function setToolResult(id, name, args, result) {
        const block = toolBlocks.get(id);
        if (!block) return;
        const isError = /^Error:/i.test(result || "");
        const spinner = block.querySelector(".tspinner");
        if (spinner) {
            spinner.outerHTML = isError
                ? '<span class="txmark">✗</span>'
                : '<span class="tcheck">✓</span>';
        }
        if (isError) block.classList.add("error");

        const body = block.querySelector(".tool-body");
        const r = el("div", "", body);
        r.innerHTML =
            '<div class="tlabel">Result</div><div class="tresult"></div>';
        r.querySelector(".tresult").textContent =
            result && result.length > 4000
                ? result.slice(0, 4000) + "\n…(truncated)"
                : result || "";

        if (EDIT_TOOLS.has(name) && !isError) {
            trackPendingEdit(id);
            const act = el("div", "tool-actions", block);
            const viewBtn = el("button", "btn ghost small", act);
            viewBtn.textContent = "View diff";
            viewBtn.addEventListener("click", () =>
                vscode.postMessage({ type: "showDiff", id })
            );

            const applyBtn = el("button", "btn primary small", act);
            applyBtn.textContent = "Apply";
            applyBtn.addEventListener("click", () => {
                applyBtn.disabled = true;
                applyBtn.textContent = "Applying…";
                vscode.postMessage({ type: "applyEdit", id });
            });

            const rejectBtn = el("button", "btn ghost small", act);
            rejectBtn.textContent = "Reject";
            rejectBtn.addEventListener("click", () => {
                rejectBtn.disabled = true;
                vscode.postMessage({ type: "rejectEdit", id });
            });
        }

        scrollToBottom();
    }

    function updateEditResult(id, state) {
        var block = toolBlocks.get(id);
        if (!block) return;
        block.classList.remove("error");
        removePendingEdit(id);
        if (state === "applied") {
            block.classList.add("applied");
            lastAppliedEditId = id;
            var metaEl = block.querySelector(".tmeta");
            var filePath = metaEl ? metaEl.textContent : "";
            showUndoBar(id, filePath);
        }
        if (state === "rejected") block.classList.add("rejected");
        var actions = block.querySelector(".tool-actions");
        if (actions) {
            actions.innerHTML = "";
            var statusLabel = document.createElement("span");
            statusLabel.className = "status-label";
            statusLabel.textContent = state === "applied" ? "\u2713 Applied" : "\u2717 Rejected";
            actions.appendChild(statusLabel);
            var viewBtn = document.createElement("button");
            viewBtn.className = "btn ghost small";
            viewBtn.textContent = "View diff";
            viewBtn.addEventListener("click", function() {
                vscode.postMessage({ type: "showDiff", id: id });
            });
            actions.appendChild(viewBtn);
        }
    }

    function send() {
        if (!signedIn) return;
        var rawText = inp.value.trim();
        if (!rawText) return;

        // During streaming in agent mode: send as live message
        if (streaming && mode === "agent") {
            addMsg("user", rawText);
            inp.value = "";
            autoSize();
            vscode.postMessage({ type: "send", text: rawText, mode: "agent" });
            return;
        }
        if (streaming) return;

        // Build the final text with attached files context
        var finalText = rawText;
        if (attachedFiles.length) {
            var ctx = "\n\n---\n**Attached files:**\n";
            attachedFiles.forEach(function (af) {
                if (af.isImage) {
                    ctx += "\n[Image: " + af.name + "]\n";
                } else {
                    var snippet = (af.content || "").slice(0, 8000);
                    ctx += "\n`" + (af.path || af.name) + "`:\n```\n" + snippet + "\n```\n";
                }
            });
            finalText += ctx;
            attachedFiles = [];
            renderAttachedFiles();
        }

        addMsg("user", rawText);
        forceScrollToBottom(true);
        inp.value = "";
        autoSize();
        showStatusPill("Thinking…");
        toolBlocks.clear();
        pendingEditIds = [];
        finalizeCurrent();
        setStreaming(true);
        vscode.postMessage({ type: "send", text: finalText, mode: mode });
    }

    function autoSize() {
        if (savedHeight) {
            updateSendActive();
            return;
        }
        inp.style.height = "auto";
        inp.style.height = Math.min(inp.scrollHeight, 200) + "px";
        updateSendActive();
    }

    function applyComposerHeight(h) {
        if (!h || h < 36) {
            inp.style.removeProperty("height");
            composer.style.removeProperty("--composer-height");
            return;
        }
        const clamped = Math.max(36, Math.min(h, 400));
        inp.style.height = clamped + "px";
        composer.style.setProperty("--composer-height", clamped + "px");
    }
    applyComposerHeight(savedHeight);

    if (composerResizer) {
        let startY = 0,
            startH = 0,
            dragging = false;
        function onMove(e) {
            if (!dragging) return;
            const delta = startY - e.clientY;
            const h = Math.max(36, Math.min(400, startH + delta));
            applyComposerHeight(h);
            savedHeight = h;
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            composerResizer.classList.remove("dragging");
            document.body.style.removeProperty("user-select");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            try {
                localStorage.setItem("onlysq.composerH", String(savedHeight));
            } catch {}
        }
        composerResizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            dragging = true;
            startY = e.clientY;
            startH = inp.getBoundingClientRect().height;
            composerResizer.classList.add("dragging");
            document.body.style.userSelect = "none";
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
        composerResizer.addEventListener("dblclick", () => {
            savedHeight = 0;
            try {
                localStorage.removeItem("onlysq.composerH");
            } catch {}
            applyComposerHeight(0);
            autoSize();
        });
    }

    inp.addEventListener("input", autoSize);
    inp.addEventListener("focus", () => composer.classList.add("focused"));
    inp.addEventListener("blur", () => composer.classList.remove("focused"));
    inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    });
    sendBtn.addEventListener("click", send);
    stopBtn.addEventListener("click", () =>
        vscode.postMessage({ type: "cancel" })
    );

    function setPaused(value, reason) {
        paused = !!value;
        if (pauseBtn) {
            pauseBtn.classList.toggle("on", paused);
            pauseBtn.title = paused ? "Resume agent" : "Pause after current step";
            // SVG: play triangle when paused, pause bars when running
            pauseBtn.innerHTML = paused
                ? '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20" fill="currentColor" stroke="none"/></svg>'
                : '<svg viewBox="0 0 24 24"><line x1="10" y1="6" x2="10" y2="18"/><line x1="14" y1="6" x2="14" y2="18"/></svg>';
        }
        if (paused) {
            showStatusPill(reason || "Paused. Press Resume to continue.");
        } else {
            if (statusPill) clearStatusPill();
        }
    }

    if (pauseBtn) {
        pauseBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "togglePause" });
        });
    }

    agentBtn.addEventListener("click", () =>
        setMode(mode === "agent" ? "chat" : "agent")
    );

    newBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "newChat" });
    });
    authBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (authBtn.disabled) return;
        vscode.postMessage({ type: "signIn" });
    });

    modelPill.addEventListener("click", () => {
        modalBackdrop.classList.add("open");
        modelSearch.value = "";
        renderModels("");
        setTimeout(() => modelSearch.focus(), 20);
    });
    modalBackdrop.addEventListener("click", (e) => {
        if (e.target === modalBackdrop) modalBackdrop.classList.remove("open");
    });
    modelSearch.addEventListener("input", () =>
        renderModels(modelSearch.value)
    );
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modalBackdrop.classList.contains("open")) {
            modalBackdrop.classList.remove("open");
        }
    });
    chatsBtn.addEventListener("click", () => {
        const open = chatsPanel.style.display !== "none";
        showChatsPanel(!open);
        if (!open) {
            chatsSearch.value = "";
            chatsQuery = "";
            renderChatsList();
            setTimeout(() => chatsSearch.focus(), 20);
        }
    });
    chatsNewBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "newChat" });
        showChatsPanel(false);
    });
    chatsSearch.addEventListener("input", () => {
        chatsQuery = chatsSearch.value.toLowerCase().trim();
        renderChatsList();
    });
    document.addEventListener("click", (e) => {
        if (chatsPanel.style.display === "none") return;
        if (!chatsPanel.contains(e.target) && !chatsBtn.contains(e.target)) {
            showChatsPanel(false);
        }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && chatsPanel.style.display !== "none") {
            showChatsPanel(false);
        }
    });

    chatTitleEl.addEventListener("click", () => beginRenameTitle());

    function beginRenameTitle() {
        if (!chatsState.activeId) return;
        const cur = chatTitleEl.textContent || "";
        chatTitleEl.contentEditable = "true";
        chatTitleEl.classList.add("editing");
        chatTitleEl.focus();
        const range = document.createRange();
        range.selectNodeContents(chatTitleEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        function finish(save) {
            chatTitleEl.contentEditable = "false";
            chatTitleEl.classList.remove("editing");
            const next = (chatTitleEl.textContent || "").trim();
            if (save && next && next !== cur) {
                vscode.postMessage({
                    type: "renameChat",
                    id: chatsState.activeId,
                    title: next,
                });
            } else {
                chatTitleEl.textContent = cur;
            }
            chatTitleEl.removeEventListener("blur", onBlur);
            chatTitleEl.removeEventListener("keydown", onKey);
        }
        function onBlur() {
            finish(true);
        }
        function onKey(e) {
            if (e.key === "Enter") {
                e.preventDefault();
                finish(true);
            }
            if (e.key === "Escape") {
                e.preventDefault();
                finish(false);
            }
        }
        chatTitleEl.addEventListener("blur", onBlur);
        chatTitleEl.addEventListener("keydown", onKey);
    }

    function renderChatsList() {
        const q = chatsQuery;
        const filtered = chatsState.list.filter(
            (c) =>
                !q ||
                c.title.toLowerCase().includes(q) ||
                c.preview.toLowerCase().includes(q)
        );
        chatsList.innerHTML = "";
        if (!filtered.length) {
            const e = el("div", "muted small", chatsList);
            e.style.padding = "10px";
            e.textContent = q
                ? "No matching chats."
                : "No chats yet. Send a message to start.";
            return;
        }
        for (const c of filtered) {
            const it = el(
                "div",
                "chat-item" + (c.id === chatsState.activeId ? " active" : ""),
                chatsList
            );
            it.dataset.id = c.id;
            const main = el("div", "chat-item-main", it);
            const title = el("div", "chat-item-title", main);
            title.textContent = c.title;
            const meta = el("div", "chat-item-meta", main);
            meta.textContent =
                `${c.messageCount} msg · ${formatRelTime(c.updatedAt)}` +
                (c.preview && c.preview !== "(empty)" ? ` · ${c.preview}` : "");

            const actions = el("div", "chat-item-actions", it);
            const renameB = el("button", "", actions);
            renameB.title = "Rename";
            renameB.textContent = "✎";
            renameB.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const next = await showPrompt("Rename chat:", c.title);
                if (next != null && next.trim()) {
                    vscode.postMessage({
                        type: "renameChat",
                        id: c.id,
                        title: next.trim(),
                    });
                }
            });

            const delB = el("button", "danger", actions);
            delB.title = "Delete";
            delB.textContent = "🗑";
            delB.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const ok = await showConfirm(`Delete chat "${c.title}"?`, {
                    destructive: true,
                    okLabel: "Delete",
                });
                if (ok) {
                    vscode.postMessage({ type: "deleteChat", id: c.id });
                }
            });
            it.addEventListener("click", () => {
                vscode.postMessage({ type: "switchChat", id: c.id });
                showChatsPanel(false);
            });
        }
    }

    function formatRelTime(ts) {
        const diff = Date.now() - ts;
        const s = Math.floor(diff / 1000);
        if (s < 60) return `${s}s ago`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        if (d < 30) return `${d}d ago`;
        return new Date(ts).toLocaleDateString();
    }

    function setActiveChatTitle(title) {
        chatTitleEl.textContent = title || "New chat";
    }
    function renderModels(query) {
        const q = String(query || "")
            .toLowerCase()
            .trim();
        const filtered = models.filter(
            (m) =>
                !q ||
                m.id.toLowerCase().includes(q) ||
                m.owner.toLowerCase().includes(q)
        );
        const groups = {};
        for (const m of filtered) (groups[m.owner] ??= []).push(m);
        modelList.innerHTML = "";
        const owners = Object.keys(groups).sort();
        for (const owner of owners) {
            const g = el("div", "model-group", modelList);
            const t = el("div", "model-group-title", g);
            t.textContent = owner;
            for (const m of groups[owner]) {
                const it = el(
                    "div",
                    "model-item" + (m.id === currentModel ? " selected" : ""),
                    g
                );
                const sp = document.createElement("span");
                sp.textContent = m.id;
                it.appendChild(sp);
                it.addEventListener("click", () => {
                    if (settingsModelTarget) {
                        vscode.postMessage({
                            type: "setSetting",
                            key: settingsModelTarget,
                            value: m.id,
                        });
                        settingsModelTarget = null;
                    } else {
                        vscode.postMessage({
                            type: "selectModel",
                            model: m.id,
                        });
                    }
                    modalBackdrop.classList.remove("open");
                });
            }
        }
        if (!owners.length) {
            const empty = el("div", "muted small", modelList);
            empty.style.padding = "12px";
            empty.textContent = "No matching models.";
        }
    }

    function updateLoadMoreVisibility() {
        show(loadMoreWrap, !!canLoadMore);
    }

    if (loadMoreBtn) {
        loadMoreBtn.addEventListener("click", () => {
            if (!canLoadMore || isLoadingMore) return;
            isLoadingMore = true;
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = "Loading…";
            vscode.postMessage({ type: "loadMore" });
        });
    }

    logEl.addEventListener("scroll", () => {
        const atBottom = isAtBottom();

        if (stickToBottom && !atBottom) {
            stickToBottom = false;
            updateScrollBtn();
        } else if (!stickToBottom && atBottom) {
            stickToBottom = true;
            updateScrollBtn();
        }

        clearTimeout(scrollTrimDebounce);
    });

    window.addEventListener("message", (e) => {
        const m = e.data;
        if (!m) return;
        if (m.type !== "__log") log("recv", m.type);
        switch (m.type) {
            case "auth":
                setAuth(m);
                break;
            case "models":
                setModel(currentModel, m.list);
                break;
            case "model":
                setModel(m.id);
                break;
            case "token":
                clearStatusPill();
                if (!currentBody) startAssistantBody();
                currentAcc += m.text;
                // Mark existing children so we can animate only new ones
                var prevCount = currentBody.childNodes.length;
                currentBody.innerHTML = renderMarkdown(currentAcc);
                // Animate only newly added top-level children
                var kids = currentBody.childNodes;
                for (var ci = prevCount; ci < kids.length; ci++) {
                    if (kids[ci].nodeType === 1) kids[ci].style.animation = "chunkIn 0.18s ease-out";
                }
                var parentMsg2 = currentBody.closest(".msg");
                if (parentMsg2) {
                    parentMsg2.dataset.raw = currentAcc;
                    parentMsg2.classList.remove("new-msg");
                }
                currentBody.classList.add("cursor");
                scrollToBottom();
                break;
            case "tool-call":
                if (currentBody) {
                    currentBody.classList.remove("cursor");
                    currentBody = null;
                    currentAcc = "";
                }
                addToolBlock(m.id, m.name, m.args);
                break;
            case "tool-result":
                setToolResult(m.id, m.name, m.args, m.result);
                showStatusPill("Thinking…");
                break;
            case "editResult":
                updateEditResult(m.id, m.state);
                break;
            case "thinking":
                showStatusPill(m.text || "Thinking…");
                break;
            case "step":
                if (m.step && m.maxSteps) {
                    showStatusPill("Step " + m.step + "/" + m.maxSteps);
                }
                break;
            case "done":
                finalizeCurrent();
                clearStatusPill();
                setStreaming(false);
                if (m.reason === "max_steps") {
                    const e2 = el("div", "max-steps-notice", logBody);
                    e2.innerHTML =
                        "<strong>Agent reached max steps.</strong> " +
                        'Type "continue" to keep going, or increase <code>onlysq.agent.maxSteps</code> in settings.';
                } else if (m.reason) {
                    const e2 = el("div", "err small muted", logBody);
                    e2.textContent = "[" + m.reason + "]";
                }
                // Auto-group completed tool blocks
                setTimeout(groupCompletedTools, 100);
                break;
            case "error":
                clearStatusPill();
                finalizeCurrent();
                const er = el("div", "err", logBody);
                er.textContent = "Error: " + m.message;
                setStreaming(false);
                break;
            case "replace":
                logBody.innerHTML = "";
                toolBlocks.clear();
                finalizeCurrent();
                clearStatusPill();
                if (m.messages && m.messages.length)
                    renderHistoryMessages(m.messages, false);
                else renderEmpty();
                break;
            case "prepend":
                if (m.messages && m.messages.length) {
                    const prevHeight = logEl.scrollHeight;
                    const prevTop = logEl.scrollTop;
                    for (let i = m.messages.length - 1; i >= 0; i--) {
                        addMsg(m.messages[i].role, m.messages[i].content, true);
                    }
                    const delta = logEl.scrollHeight - prevHeight;
                    logEl.scrollTop = prevTop + delta;
                }
                isLoadingMore = false;
                loadMoreBtn.disabled = false;
                loadMoreBtn.textContent = "Load previous messages";
                break;
            case "trimTo":
                if (streaming) break;
                {
                    const msgs = Array.from(logBody.querySelectorAll(".msg"));
                    const drop = msgs.length - m.keep;
                    if (drop > 0) {
                        const stopAt = msgs[drop];
                        const toRemove = [];
                        for (const ch of logBody.children) {
                            if (ch === stopAt) break;
                            toRemove.push(ch);
                        }
                        for (const r of toRemove) r.remove();
                    }
                }
                break;
            case "canLoadMore":
                canLoadMore = !!m.value;
                updateLoadMoreVisibility();
                break;
            case "chats":
                chatsState = {
                    list: m.list || [],
                    activeId: m.activeId || null,
                };
                if (chatsState.activeId) {
                    const active = chatsState.list.find(
                        (c) => c.id === chatsState.activeId
                    );
                    setActiveChatTitle(active?.title);
                } else {
                    setActiveChatTitle("New chat");
                }
                if (chatsPanel.style.display !== "none") renderChatsList();
                break;

            case "ask-user":
                clearStatusPill();
                renderAskUser(m.id, m.question, m.options, m.multiSelect);
                break;
            case "pauseState":
                setPaused(!!m.paused, m.reason);
                break;
            case "settings":
                renderSettings(m);
                break;
            case "openSettings":
                showSettings(true);
                vscode.postMessage({ type: "getSettings" });
                break;
            case "mentionResults":
                if (mentionActive && Array.isArray(m.files)) {
                    mentionItems = m.files.slice(0, 10);
                    mentionIdx = 0;
                    renderMentionPopup();
                }
                break;
            case "fileContent":
                if (typeof m.path === "string" && typeof m.content === "string") {
                    // add as attached file if not already present
                    var exists = attachedFiles.some(function(af) { return af.path === m.path; });
                    if (!exists) {
                        var name = m.path.split("/").pop() || m.path;
                        attachedFiles.push({ name: name, path: m.path, content: m.content, isImage: false });
                        renderAttachedFiles();
                    }
                }
                break;
            case "undoResult":
                if (m.success) {
                    var undoBar = logBody.querySelector('.undo-bar[data-id="' + m.id + '"]');
                    if (undoBar) {
                        undoBar.innerHTML = '<span class="small muted">✓ Undone</span>';
                        setTimeout(function() { undoBar.remove(); }, 2000);
                    }
                    // reset the edit block state
                    var block = toolBlocks.get(m.id);
                    if (block) {
                        block.classList.remove("applied");
                        // re-add pending
                        trackPendingEdit(m.id);
                    }
                }
                break;
        }
    });

    function showConfirm(message, options) {
        return new Promise((resolveP) => {
            const opts = options || {};
            const backdrop = document.createElement("div");
            backdrop.className = "modal-backdrop open";
            backdrop.style.zIndex = "200";

            const modal = document.createElement("div");
            modal.className = "confirm-modal";
            backdrop.appendChild(modal);

            const msg = document.createElement("div");
            msg.className = "confirm-message";
            msg.textContent = message;
            modal.appendChild(msg);

            const actions = document.createElement("div");
            actions.className = "confirm-actions";
            modal.appendChild(actions);

            const cancelBtn = document.createElement("button");
            cancelBtn.className = "btn ghost small";
            cancelBtn.textContent = opts.cancelLabel || "Cancel";
            actions.appendChild(cancelBtn);

            const okBtn = document.createElement("button");
            okBtn.className = opts.destructive
                ? "btn danger small"
                : "btn primary small";
            okBtn.textContent = opts.okLabel || "OK";
            actions.appendChild(okBtn);

            function close(value) {
                backdrop.remove();
                document.removeEventListener("keydown", onKey);
                resolveP(value);
            }
            function onKey(e) {
                if (e.key === "Escape") {
                    e.preventDefault();
                    close(false);
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    close(true);
                }
            }

            cancelBtn.addEventListener("click", () => close(false));
            okBtn.addEventListener("click", () => close(true));
            backdrop.addEventListener("click", (e) => {
                if (e.target === backdrop) close(false);
            });
            document.addEventListener("keydown", onKey);

            document.body.appendChild(backdrop);
            setTimeout(() => okBtn.focus(), 20);
        });
    }

    function showPrompt(message, defaultValue) {
        return new Promise((resolveP) => {
            const backdrop = document.createElement("div");
            backdrop.className = "modal-backdrop open";
            backdrop.style.zIndex = "200";

            const modal = document.createElement("div");
            modal.className = "confirm-modal";
            backdrop.appendChild(modal);

            const msg = document.createElement("div");
            msg.className = "confirm-message";
            msg.textContent = message;
            modal.appendChild(msg);

            const input = document.createElement("input");
            input.type = "text";
            input.className = "setting-input";
            input.style.width = "100%";
            input.style.marginTop = "8px";
            input.value = defaultValue || "";
            modal.appendChild(input);

            const actions = document.createElement("div");
            actions.className = "confirm-actions";
            modal.appendChild(actions);

            const cancelBtn = document.createElement("button");
            cancelBtn.className = "btn ghost small";
            cancelBtn.textContent = "Cancel";
            actions.appendChild(cancelBtn);

            const okBtn = document.createElement("button");
            okBtn.className = "btn primary small";
            okBtn.textContent = "OK";
            actions.appendChild(okBtn);

            function close(value) {
                backdrop.remove();
                document.removeEventListener("keydown", onKey);
                resolveP(value);
            }
            function onKey(e) {
                if (e.key === "Escape") {
                    e.preventDefault();
                    close(null);
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    close(input.value);
                }
            }

            cancelBtn.addEventListener("click", () => close(null));
            okBtn.addEventListener("click", () => close(input.value));
            backdrop.addEventListener("click", (e) => {
                if (e.target === backdrop) close(null);
            });
            document.addEventListener("keydown", onKey);

            document.body.appendChild(backdrop);
            setTimeout(() => {
                input.focus();
                input.select();
            }, 20);
        });
    }

    function isAtBottom() {
        return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
    }

    function scrollToBottom(smooth) {
        if (!stickToBottom) return;
        if (smooth)
            logEl.scrollTo({ top: logEl.scrollHeight, behavior: "smooth" });
        else logEl.scrollTop = logEl.scrollHeight;
    }

    function forceScrollToBottom(smooth) {
        stickToBottom = true;
        updateScrollBtn();
        if (smooth)
            logEl.scrollTo({ top: logEl.scrollHeight, behavior: "smooth" });
        else logEl.scrollTop = logEl.scrollHeight;
    }

    function ensureScrollBtn() {
        if (scrollBtn) return scrollBtn;
        scrollBtn = document.createElement("button");
        scrollBtn.className = "scroll-bottom-btn";
        scrollBtn.title = "Jump to latest";
        scrollBtn.innerHTML = '<span class="arrow">↓</span>';
        scrollBtn.addEventListener("click", () => forceScrollToBottom(true));
        logEl.parentElement.appendChild(scrollBtn);
        return scrollBtn;
    }

    function updateScrollBtn() {
        ensureScrollBtn().classList.toggle("visible", !stickToBottom);
    }

    function showSettings(visible) {
        settingsPanel.dataset.visible = visible ? "true" : "false";
        settingsPanel.style.display = visible ? "flex" : "none";
    }

    function showChatsPanel(visible) {
        chatsPanel.dataset.visible = visible ? "true" : "false";
        chatsPanel.style.display = visible ? "flex" : "none";
    }

    // ========== Feature 1: Code block copy button (delegated) ==========
    logBody.addEventListener("click", function (e) {
        var btn = e.target.closest(".code-copy-btn");
        if (!btn) return;
        var wrap = btn.closest(".code-block-wrap");
        var codeEl = wrap && wrap.querySelector("pre code");
        var text = codeEl ? codeEl.textContent : (btn.dataset.code || "");
        try {
            navigator.clipboard.writeText(text);
            btn.textContent = "Copied!";
            btn.classList.add("copied");
            setTimeout(function () {
                btn.textContent = "Copy";
                btn.classList.remove("copied");
            }, 1500);
        } catch (err) {}
    });

    // ========== Feature 2: @-mentions ==========
    var mentionDebounce;
    inp.addEventListener("input", function () {
        autoSize();
        checkMention();
    });
    inp.addEventListener("keydown", function (e) {
        if (!mentionActive) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            mentionIdx = Math.min(mentionIdx + 1, mentionItems.length - 1);
            renderMentionPopup();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            mentionIdx = Math.max(mentionIdx - 1, 0);
            renderMentionPopup();
        } else if (e.key === "Enter" && mentionItems.length) {
            e.preventDefault();
            acceptMention(mentionItems[mentionIdx]);
        } else if (e.key === "Escape") {
            closeMention();
        }
    });
    function checkMention() {
        var val = inp.value;
        var cur = inp.selectionStart;
        var lastAt = val.lastIndexOf("@", cur - 1);
        if (lastAt === -1 || (lastAt > 0 && /\S/.test(val[lastAt - 1]))) {
            closeMention();
            return;
        }
        var query = val.slice(lastAt + 1, cur);
        if (/\s/.test(query) && query.length > 20) {
            closeMention();
            return;
        }
        mentionStart = lastAt;
        mentionActive = true;
        clearTimeout(mentionDebounce);
        mentionDebounce = setTimeout(function () {
            vscode.postMessage({ type: "mentionSearch", query: query });
        }, 150);
    }
    function closeMention() {
        mentionActive = false;
        mentionStart = -1;
        mentionIdx = 0;
        mentionItems = [];
        if (mentionPopup) mentionPopup.classList.remove("visible");
    }
    function renderMentionPopup() {
        if (!mentionPopup || !mentionItems.length) {
            if (mentionPopup) mentionPopup.classList.remove("visible");
            return;
        }
        mentionPopup.innerHTML = "";
        mentionPopup.classList.add("visible");
        mentionItems.forEach(function (file, i) {
            var it = el("div", "mention-item" + (i === mentionIdx ? " active" : ""), mentionPopup);
            it.innerHTML = '<span class="mention-icon">📄</span><span class="mention-path">' + escapeHtml(file) + '</span>';
            it.addEventListener("mousedown", function (e) {
                e.preventDefault();
                acceptMention(file);
            });
        });
    }
    function acceptMention(file) {
        var val = inp.value;
        var cur = inp.selectionStart;
        var before = val.slice(0, mentionStart);
        var after = val.slice(cur);
        inp.value = before + "@" + file + " " + after;
        var newPos = before.length + 1 + file.length + 1;
        inp.setSelectionRange(newPos, newPos);
        closeMention();
        // Request file content to attach
        vscode.postMessage({ type: "readFileContent", path: file });
        autoSize();
    }

    // ========== Feature 3: Drag & Drop files ==========
    var composerWrapEl = $("composerWrap");
    var dragCounter = 0;
    if (composerWrapEl && dropOverlay) {
        composerWrapEl.addEventListener("dragenter", function (e) {
            e.preventDefault();
            dragCounter++;
            dropOverlay.classList.add("visible");
        });
        composerWrapEl.addEventListener("dragleave", function (e) {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                dropOverlay.classList.remove("visible");
            }
        });
        composerWrapEl.addEventListener("dragover", function (e) {
            e.preventDefault();
        });
        composerWrapEl.addEventListener("drop", function (e) {
            e.preventDefault();
            dragCounter = 0;
            dropOverlay.classList.remove("visible");
            var files = e.dataTransfer && e.dataTransfer.files;
            if (!files || !files.length) return;
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                addDroppedFile(f);
            }
        });
    }
    function addDroppedFile(f) {
        var reader = new FileReader();
        if (f.type && f.type.startsWith("image/")) {
            reader.onload = function () {
                var base64 = reader.result;
                attachedFiles.push({ name: f.name, path: null, content: base64, isImage: true });
                renderAttachedFiles();
            };
            reader.readAsDataURL(f);
        } else {
            reader.onload = function () {
                attachedFiles.push({ name: f.name, path: null, content: reader.result, isImage: false });
                renderAttachedFiles();
            };
            reader.readAsText(f);
        }
    }
    function renderAttachedFiles() {
        if (!attachedFilesEl) return;
        attachedFilesEl.innerHTML = "";
        attachedFiles.forEach(function (af, idx) {
            var chip = el("div", "attached-file", attachedFilesEl);
            var icon = af.isImage ? "🖼" : "📄";
            chip.innerHTML = '<span>' + icon + '</span><span class="af-name">' + escapeHtml(af.name) + '</span>';
            var removeBtn = el("button", "af-remove", chip);
            removeBtn.textContent = "×";
            removeBtn.addEventListener("click", function () {
                attachedFiles.splice(idx, 1);
                renderAttachedFiles();
            });
        });
    }

    // ========== Feature 4: Multi-file diff (Apply All / Reject All) ==========
    function trackPendingEdit(id) {
        if (!pendingEditIds.includes(id)) pendingEditIds.push(id);
        updateMultiDiffBar();
    }
    function removePendingEdit(id) {
        pendingEditIds = pendingEditIds.filter(function(x) { return x !== id; });
        updateMultiDiffBar();
    }
    function updateMultiDiffBar() {
        var existing = logBody.querySelector(".multi-diff-bar");
        if (pendingEditIds.length < 2) {
            if (existing) existing.remove();
            return;
        }
        if (!existing) {
            existing = el("div", "multi-diff-bar", logBody);
        }
        existing.innerHTML =
            '<span class="mdb-label">' + pendingEditIds.length + ' pending edits</span>' +
            '<div class="mdb-actions">' +
            '<button class="btn primary small" id="applyAllBtn">Apply All</button>' +
            '<button class="btn ghost small" id="rejectAllBtn">Reject All</button>' +
            '</div>';
        existing.querySelector("#applyAllBtn").addEventListener("click", function () {
            vscode.postMessage({ type: "applyAllEdits", ids: pendingEditIds.slice() });
            pendingEditIds = [];
            updateMultiDiffBar();
        });
        existing.querySelector("#rejectAllBtn").addEventListener("click", function () {
            vscode.postMessage({ type: "rejectAllEdits", ids: pendingEditIds.slice() });
            pendingEditIds = [];
            updateMultiDiffBar();
        });
    }

    // ========== Feature 5: Undo last agent action ==========
    function showUndoBar(id, path) {
        var existing = logBody.querySelector(".undo-bar");
        if (existing) existing.remove();
        var bar = el("div", "undo-bar", logBody);
        bar.dataset.id = id;
        bar.innerHTML = '<span>Applied: ' + escapeHtml(path || "file") + '</span>';
        var undoBtn = el("button", "undo-btn", bar);
        undoBtn.textContent = "Undo";
        undoBtn.addEventListener("click", function () {
            undoBtn.disabled = true;
            undoBtn.textContent = "Undoing…";
            vscode.postMessage({ type: "undoLastEdit", id: id });
        });
        scrollToBottom();
    }

    // ========== Feature 6: Export chat ==========
    if (exportBtn && exportMenu) {
        exportBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            exportMenu.classList.toggle("visible");
        });
        document.addEventListener("click", function () {
            exportMenu.classList.remove("visible");
        });
        exportMenu.querySelectorAll(".export-menu-item").forEach(function (btn) {
            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                var format = btn.dataset.format;
                vscode.postMessage({ type: "exportChat", format: format });
                exportMenu.classList.remove("visible");
            });
        });
    }

    // ========== Tool Grouping: collapse completed tools ==========
    function groupCompletedTools() {
        // Don't re-group if already grouped
        if (logBody.querySelector(".tool-group-collapsed")) return;
        var allChildren = Array.from(logBody.children);
        var consecutive = [];
        function flush() {
            if (consecutive.length >= 3) collapseGroup(consecutive.slice());
            consecutive = [];
        }
        for (var i = 0; i < allChildren.length; i++) {
            var node = allChildren[i];
            if (node.classList && node.classList.contains("tool-block")) {
                var hasCheck = node.querySelector(".tcheck");
                var isEditPending = node.querySelector(".tool-actions .btn.primary");
                if (hasCheck && !isEditPending) {
                    consecutive.push(node);
                    continue;
                }
            }
            flush();
        }
        flush();
    }
    function collapseGroup(blocks) {
        var header = document.createElement("div");
        header.className = "tool-group-collapsed";
        var names = {};
        blocks.forEach(function(b) {
            var n = b.querySelector(".tname");
            if (n) names[n.textContent] = (names[n.textContent] || 0) + 1;
        });
        var summary = Object.entries(names).map(function(e) { return e[1] + "x " + e[0]; }).join(", ");
        header.innerHTML = '<span class="tgc-icon">\u2713</span>' +
            '<span>' + blocks.length + ' tools (' + summary + ')</span>' +
            '<span class="tgc-arrow">\u25B6</span>';
        var container = document.createElement("div");
        container.className = "tool-group-expanded";
        var first = blocks[0];
        first.parentNode.insertBefore(header, first);
        first.parentNode.insertBefore(container, header.nextSibling);
        blocks.forEach(function(b) { container.appendChild(b); });
        header.addEventListener("click", function() {
            header.classList.toggle("open");
        });
    }

    // ========== Context Pins ==========
    var contextPinsEl = $("contextPins");
    var contextPins = []; // { path, content }
    function addContextPin(path, content) {
        if (contextPins.some(function(p) { return p.path === path; })) return;
        contextPins.push({ path: path, content: content || "" });
        renderContextPins();
    }
    function removeContextPin(path) {
        contextPins = contextPins.filter(function(p) { return p.path !== path; });
        renderContextPins();
    }
    function renderContextPins() {
        if (!contextPinsEl) return;
        contextPinsEl.innerHTML = "";
        contextPins.forEach(function(pin) {
            var chip = el("div", "pin-chip", contextPinsEl);
            chip.innerHTML = '<span class="pin-icon">\ud83d\udccc</span><span>' + escapeHtml(pin.path.split('/').pop() || pin.path) + '</span>';
            chip.title = pin.path;
            var rm = el("button", "pin-remove", chip);
            rm.textContent = "\u00d7";
            rm.addEventListener("click", function() { removeContextPin(pin.path); });
        });
    }

    // ========== Image preview in attachments ==========
    var _origRenderAttached = renderAttachedFiles;
    renderAttachedFiles = function() {
        if (!attachedFilesEl) return;
        attachedFilesEl.innerHTML = "";
        attachedFiles.forEach(function (af, idx) {
            var chip = el("div", "attached-file" + (af.isImage ? " is-image" : ""), attachedFilesEl);
            if (af.isImage && af.content) {
                var img = document.createElement("img");
                img.className = "af-preview";
                img.src = af.content;
                chip.appendChild(img);
            }
            var nameSpan = el("span", "af-name", chip);
            nameSpan.textContent = af.name;
            var removeBtn = el("button", "af-remove", chip);
            removeBtn.textContent = "\u00d7";
            removeBtn.addEventListener("click", function () {
                attachedFiles.splice(idx, 1);
                renderAttachedFiles();
            });
        });
    };

    // Auto-group tools when streaming ends
    var _origDoneHandler = null;
    // We hook into the done case — after it finishes we group
    // (done is already handled above, we call groupCompletedTools after)

    showSettings(false);
    showChatsPanel(false);
    setStreaming(false);
    log("ready, sending ready message");
    vscode.postMessage({ type: "ready" });
})();
