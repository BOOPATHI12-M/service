/*
 * Laptop-control backend API + web frontend — JavaScript (Node/Express) version.
 * A direct translation of app.py: no database, no login, in-memory command queue.
 *
 *   button click -> POST /api/command   (queued in memory)   <-- CREATE happens here
 *   agent polls   -> GET  /api/command/next
 *   agent returns -> POST /api/result
 *   browser shows -> GET  /api/result/:id   (then auto-removes it)
 *
 * Run:  cd server && npm install && npm start      (http://localhost:8000)
 *
 * State lives in process memory, so it resets when the server restarts. The
 * dashboard is open (no login); only the agent endpoints require X-Agent-Key.
 */

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
// ---- Config (env-overridable, mirrors config.py) --------------------------
const HOST = process.env.HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "8000", 10);
const AGENT_KEY = process.env.AGENT_KEY || "super-secret-agent-key-change-me";

const app = express();
app.use(express.json({ limit: "25mb" })); // base64 screenshots can be large
app.use("/static", express.static(path.join(__dirname, "static")));

// ===========================================================================
//  In-memory store (replaces the database)
// ===========================================================================
let seq = 0;
const commands = new Map(); // id -> { tool_no, payload, status: pending|taken|done }
const results = new Map();  // command_id -> { content_type, data }

function newCommand(toolNo, payload) {
  // CREATE a command: the frontend calls this via POST /api/command.
  const id = ++seq;
  commands.set(id, { tool_no: toolNo, payload: payload ?? null, status: "pending" });
  return id;
}

function takeNextCommand() {
  // Hand the oldest pending command to the agent, marking it 'taken'.
  for (const id of [...commands.keys()].sort((a, b) => a - b)) {
    const c = commands.get(id);
    if (c.status === "pending") {
      c.status = "taken";
      return { id, tool_no: c.tool_no, payload: c.payload };
    }
  }
  return null;
}

function storeResult(commandId, contentType, data) {
  results.set(commandId, { content_type: contentType, data });
  if (commands.has(commandId)) commands.get(commandId).status = "done";
}

function popResult(commandId) {
  // Return a result if ready, then delete it + its command (delete-on-read).
  if (!results.has(commandId)) return null;
  const result = results.get(commandId);
  results.delete(commandId);
  commands.delete(commandId);
  return result;
}

function deleteCommand(commandId) {
  results.delete(commandId);
  return commands.delete(commandId) ? 1 : 0;
}

function clearCommands() {
  const n = commands.size;
  commands.clear();
  results.clear();
  return n;
}

// ===========================================================================
//  Middleware — only the agent side is protected
// ===========================================================================
function agentRequired(req, res, next) {
  const key = req.get("X-Agent-Key") || "";
  const a = Buffer.from(key);
  const b = Buffer.from(AGENT_KEY);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: "invalid agent key" });
  next();
}

// ===========================================================================
//  Pages
// ===========================================================================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "templates", "dashboard.html"));
});

// ===========================================================================
//  Commands (browser side — open, no login)
// ===========================================================================
app.post("/api/command", (req, res) => {
  // CREATE endpoint: a button click posts {tool_no, payload?} and a command is
  // created in the in-memory queue. Returns its command_id.
  const toolNo = Number(req.body?.tool_no);
  if (!Number.isInteger(toolNo)) {
    return res.status(400).json({ error: "tool_no must be an integer" });
  }
  if (toolNo < 1 || toolNo > 9) {
    return res.status(400).json({ error: "tool_no must be 1..9" });
  }
  const commandId = newCommand(toolNo, req.body?.payload);
  res.json({ ok: true, command_id: commandId });
});
app.get("/webrtc", (req, res) => {
    res.sendFile(path.join(__dirname, "templates", "webrtc.html"));
});
app.get("/api/result/:id", (req, res) => {
  const result = popResult(Number(req.params.id)); // returns + auto-removes when ready
  if (result === null) return res.json({ ready: false });
  res.json({ ready: true, ...result });
});

app.delete("/api/command/:id", (req, res) => {
  res.json({ ok: true, removed: deleteCommand(Number(req.params.id)) });
});

app.post("/api/commands/clear", (req, res) => {
  res.json({ ok: true, removed: clearCommands() });
});

// ===========================================================================
//  Agent side (shared key)
// ===========================================================================
app.get("/api/command/next", agentRequired, (req, res) => {
  res.json({ command: takeNextCommand() });
});

app.post("/api/result", agentRequired, (req, res) => {
  const { command_id, content_type, data } = req.body || {};
  const commandId = Number(command_id);
  const validType = ["image", "json", "text"].includes(content_type);
  if (!Number.isInteger(commandId) || !validType || data == null) {
    return res
      .status(400)
      .json({ error: "command_id, content_type(image|json|text), data required" });
  }
  storeResult(commandId, content_type, data);
  res.json({ ok: true });
});

const PYTHON_API =
    process.env.PYTHON_API ||"http://127.0.0.1:8001/api/run";
app.post("/execute", async (req, res) => {

    try {

        const response = await axios.post(PYTHON_API, {
            command: req.body.command
        });

        res.json(response.data);

    } catch (err) {

        res.status(500).json({
            error: err.message
        });

    }

});

// ===========================================================================
//  Startup
// ===========================================================================
// Export the app + store for testing; only listen when run directly.
module.exports = { app, _state: { commands, results } };

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Backend running on http://${HOST}:${PORT}  (no login)`);
  });
}
