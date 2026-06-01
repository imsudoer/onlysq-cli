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
        if (b) {
            sendBtn.style.display = "none";
            stopBtn.style.display = "";
        } else {
            sendBtn.style.display = "";
            stopBtn.style.display = "none";
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

    function renderMarkdown(text) {
        if (!text) return "";
        let out = "";
        let last = 0;
        const re = new RegExp(fenceRe);
        let m;
        while ((m = re.exec(text)) !== null) {
            out += renderProse(text.slice(last, m.index));
            const lang = m[1] || "";
            const code = m[2];
            out +=
                '<pre><code class="lang-' +
                escapeHtml(lang) +
                '">' +
                highlightCode(code, lang) +
                "</code></pre>";
            last = m.index + m[0].length;
        }
        out += renderProse(text.slice(last));
        return out;
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
        m.className = "msg " + role;
        const r = el("div", "role", m);
        r.textContent = role === "user" ? "You" : "OnlySq";
        const body = el("div", "body", m);
        body.innerHTML = renderMarkdown(text);
        if (prepend) logBody.insertBefore(m, logBody.firstChild);
        else logBody.appendChild(m);
        if (!prepend) scrollToBottom();
        return body;
    }

    function renderHistoryMessages(messages, prepend) {
        const empty = logBody.querySelector(".empty");
        if (empty && messages.length) empty.remove();
        for (const m of messages) addMsg(m.role, m.content, prepend);
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
        statusPill.innerHTML =
            '<span class="sdot"></span><span class="stext"></span>';
        statusPill.querySelector(".stext").textContent = text;
        scrollToBottom();
    }

    const FILE_TOOLS = new Set([
        "read_file",
        "write_file",
        "open_file",
        "propose_edit",
        "apply_at_line",
        "patch_file",
    ]);
    const TOOL_LABELS = {
        read_file: "Reading",
        write_file: "Writing",
        propose_edit: "Editing",
        apply_at_line: "Editing",
        patch_file: "Patching",
        open_file: "Opening",
        list_dir: "Listing",
        search: "Searching",
        get_selection: "Reading selection",
        run_command: "Running",
        run_command_interactive: "Starting",
        git_status: "Git status",
        git_diff: "Git diff",
    };

    function summarizeArgs(name, args) {
        try {
            if (FILE_TOOLS.has(name) && args && args.path) {
                if (name === "apply_at_line") {
                    const r =
                        args.start_line +
                        (args.end_line ? `-${args.end_line}` : "");
                    return `${args.path}:${r}`;
                }
                return args.path;
            }
            if (name === "list_dir") return (args && args.path) || ".";
            if (name === "search")
                return "/" + ((args && args.pattern) || "") + "/";
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

        const body = el("div", "tool-body", block);

        if (args && typeof args.reason === "string" && args.reason.trim()) {
            const reasonBlock = el("div", "", body);
            reasonBlock.innerHTML =
                '<div class="tlabel">Description</div>' +
                '<div class="treason"></div>';
            reasonBlock.querySelector(".treason").textContent = args.reason;
        }

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
        // if (name === 'propose_edit') block.classList.add('open');
        return block;
    }

    const EDIT_TOOLS = new Set(["propose_edit", "apply_at_line", "patch_file"]);
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
        const block = toolBlocks.get(id);
        if (!block) return;
        block.classList.remove("error");
        if (state === "applied") block.classList.add("applied");
        if (state === "rejected") block.classList.add("rejected");
        const actions = block.querySelector(".tool-actions");
        if (actions) {
            actions.innerHTML = "";
            const viewBtn = document.createElement("button");
            viewBtn.className = "btn ghost small";
            viewBtn.textContent = "View diff";
            viewBtn.addEventListener("click", () =>
                vscode.postMessage({ type: "showDiff", id })
            );
            actions.appendChild(viewBtn);
            const label = document.createElement("span");
            label.className = "small muted";
            label.style.marginLeft = "6px";
            label.style.alignSelf = "center";
            label.textContent =
                state === "applied" ? "✓ Applied" : "✗ Rejected";
            actions.appendChild(label);
        }
    }

    function send() {
        if (!signedIn) return;
        const text = inp.value.trim();
        if (!text || streaming) return;
        addMsg("user", text);
        inp.value = "";
        autoSize();
        showStatusPill("Thinking…");
        toolBlocks.clear();
        finalizeCurrent();
        setStreaming(true);
        vscode.postMessage({ type: "send", text, mode });
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
        show(chatsPanel, !open);
        if (!open) {
            chatsSearch.value = "";
            chatsQuery = "";
            renderChatsList();
            setTimeout(() => chatsSearch.focus(), 20);
        }
    });
    chatsNewBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "newChat" });
        show(chatsPanel, false);
    });
    chatsSearch.addEventListener("input", () => {
        chatsQuery = chatsSearch.value.toLowerCase().trim();
        renderChatsList();
    });
    document.addEventListener("click", (e) => {
        if (chatsPanel.style.display === "none") return;
        if (!chatsPanel.contains(e.target) && e.target !== chatsBtn) {
            show(chatsPanel, false);
        }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && chatsPanel.style.display !== "none") {
            show(chatsPanel, false);
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
            renameB.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const next = prompt("Rename chat:", c.title);
                if (next != null)
                    vscode.postMessage({
                        type: "renameChat",
                        id: c.id,
                        title: next,
                    });
            });
            const delB = el("button", "danger", actions);
            delB.title = "Delete";
            delB.textContent = "🗑";
            delB.addEventListener("click", (ev) => {
                ev.stopPropagation();
                if (confirm(`Delete chat "${c.title}"?`)) {
                    vscode.postMessage({ type: "deleteChat", id: c.id });
                }
            });

            it.addEventListener("click", () => {
                vscode.postMessage({ type: "switchChat", id: c.id });
                show(chatsPanel, false);
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
                    vscode.postMessage({ type: "selectModel", model: m.id });
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

    let scrollTrimDebounce;
    logEl.addEventListener("scroll", () => {
        const atBottom =
            logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 8;
        if (atBottom) {
            clearTimeout(scrollTrimDebounce);
            scrollTrimDebounce = setTimeout(() => {
                const totalMsgs = logBody.querySelectorAll(".msg").length;
                if (totalMsgs > HISTORY_WINDOW) {
                    vscode.postMessage({ type: "trimToWindow" });
                }
            }, 600);
        }
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
                currentBody.innerHTML = renderMarkdown(currentAcc);
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
            case "done":
                finalizeCurrent();
                clearStatusPill();
                setStreaming(false);
                if (m.reason) {
                    const e2 = el("div", "err small muted", logBody);
                    e2.textContent = "[" + m.reason + "]";
                }
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
                    for (let i = m.messages.length - 1; i >= 0; i--) {
                        addMsg(m.messages[i].role, m.messages[i].content, true);
                    }
                    const delta = logEl.scrollHeight - prevHeight;
                    logEl.scrollTop += delta;
                }
                isLoadingMore = false;
                loadMoreBtn.disabled = false;
                loadMoreBtn.textContent = "Load previous messages";
                break;
            case "trimTo":
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
        }
    });

    setStreaming(false);
    log("ready, sending ready message");
    vscode.postMessage({ type: "ready" });
})();
