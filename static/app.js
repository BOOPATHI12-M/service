// Dashboard logic: click a tool -> create a command -> poll for the result.

const resultEl = document.getElementById("result");
const statusEl = document.getElementById("status");
const emailForm = document.getElementById("emailForm");
const streamToggleWrap = document.querySelector(".stream-toggle");
const streamLoop = document.getElementById("streamLoop");

const TOOL_NAMES = {
    1: "Screenshot", 2: "CPU Info", 3: "Camera",
    4: "Browser History", 5: "Send Email", 6: "Screen Stream",7: "USB Devices",8: "Live Camera",
    9: "Safe Terminal",
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

async function pollResult(commandId, { attempts = 80, interval = 300, shouldStop = null } = {}) {
    for (let i = 0; i < attempts; i++) {
        if (shouldStop && shouldStop()) return null;   // bail the instant we're told to stop
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
        if (toolNo === 7) { toggleUsbWatch(); return; }   // live USB plug/unplug popups
        if (toolNo === 8) {
             window.open("/live-camera", "_blank");
             return;}
        if (toolNo === 9) {                    // open the Safe Terminal in a new tab
             window.open("/terminal", "_blank");
             return;}
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

// ---- screen "stream": re-request a frame while streaming is on -------------
// Clicking tool 6 again (or unchecking "keep streaming") stops it immediately.
async function startStream() {
    if (streaming) { streaming = false; setStatus("Stream stopped", ""); return; }  // toggle off
    streaming = true;
    setStatus("Streaming…", "busy");
    do {
        let commandId;
        try {
            const res = await fetch("/api/command", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tool_no: 6, payload: null }),
            });
            if (!res.ok) break;
            commandId = (await res.json()).command_id;
        } catch { break; }
        // fast polling that aborts the moment streaming is turned off
        const result = await pollResult(commandId, { interval: 250, shouldStop: () => !streaming });
        if (!streaming) break;
        if (!result) break;                    // error/timeout stops the loop
    } while (streamLoop.checked);
    streaming = false;
    setStatus("Stream stopped", "");
}

// ---- USB monitor: pop a toast when a drive is plugged in / removed ---------
let usbWatching = false;
let usbKnown = null;                 // Map<drive, info> from the previous check

function toast(text, kind = "info") {
    let box = document.getElementById("toastBox");
    if (!box) {
        box = document.createElement("div");
        box.id = "toastBox";
        box.style.cssText =
            "position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;";
        document.body.appendChild(box);
    }
    const color = kind === "plug" ? "#00a86b" : kind === "remove" ? "#d13438" : "#555";
    const t = document.createElement("div");
    t.style.cssText =
        `background:#1c1c1c;color:#fff;border-left:4px solid ${color};padding:12px 16px;` +
        "border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.4);font:14px system-ui;min-width:220px;max-width:340px;";
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => {
        t.style.transition = "opacity .4s";
        t.style.opacity = "0";
        setTimeout(() => t.remove(), 400);
    }, 6000);
}

// Ask the agent (tool 7) for the current USB list.
async function usbSnapshot() {
    const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool_no: 7, payload: null }),
    });
    if (!res.ok) return null;
    const { command_id } = await res.json();
    for (let i = 0; i < 20; i++) {
        if (!usbWatching) return null;       // stop was pressed — bail immediately
        const r = await (await fetch(`/api/result/${command_id}`)).json();
        if (r.ready) {
            if (r.content_type === "json") { try { return JSON.parse(r.data); } catch { return []; } }
            return [];                       // text reply => no drives
        }
        await sleep(300);
    }
    return null;
}

async function usbWatchLoop() {
    while (usbWatching) {
        const list = await usbSnapshot();
        if (!usbWatching) break;
        if (list) {
            const now = new Map(list.map((d) => [d.drive, d]));
            if (usbKnown === null) {         // first check — announce what's already there
                if (now.size) for (const [drv, info] of now)
                    toast(`USB present: ${drv}${info.total_gb ? ` (${info.total_gb} GB)` : ""}`, "plug");
            } else {
                for (const [drv, info] of now) if (!usbKnown.has(drv))
                    toast(`🔌 USB connected: ${drv}${info.total_gb ? ` (${info.total_gb} GB)` : ""}`, "plug");
                for (const [drv] of usbKnown) if (!now.has(drv))
                    toast(`❌ USB removed: ${drv}`, "remove");
            }
            usbKnown = now;
        }
        await sleep(3000);                   // check every 3s
    }
}

function toggleUsbWatch() {
    usbWatching = !usbWatching;
    const btn = document.querySelector('.tool[data-tool="7"]');
    if (usbWatching) {
        usbKnown = null;
        setStatus("USB monitoring ON — plug/unplug will pop up", "ok");
        toast("USB monitoring started.", "info");
        if (btn) btn.classList.add("active");
        usbWatchLoop();
    } else {
        setStatus("USB monitoring off", "");
        if (btn) btn.classList.remove("active");
    }
}

// ---- header actions --------------------------------------------------------
document.getElementById("clearBtn").addEventListener("click", async () => {
    const res = await fetch("/api/commands/clear", { method: "POST" });
    const data = await res.json();
    setStatus(`Cleared ${data.removed} queued command(s)`, "ok");
});
