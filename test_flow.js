// End-to-end flow test for the JS backend. Run: node test_flow.js
const http = require("http");
const { app } = require("./server");

const AGENT_KEY = process.env.AGENT_KEY || "super-secret-agent-key-change-me";
let passed = 0, failed = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  cond ? passed++ : failed++;
}

function req(server, method, path, { body, headers } = {}) {
  return new Promise((resolve) => {
    const { port } = server.address();
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: "127.0.0.1", port, method, path,
        headers: { "Content-Type": "application/json", ...(headers || {}),
                   ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          resolve({ status: res.statusCode, json, text: buf });
        });
      }
    );
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const AKEY = { "X-Agent-Key": AGENT_KEY };

  // Dashboard open
  const home = await req(server, "GET", "/");
  check("/ serves dashboard (200 html)", home.status === 200 && home.text.includes("Laptop Control"));

  // Browser side open
  let r = await req(server, "POST", "/api/command", { body: { tool_no: 2 } });
  const cid = r.json.command_id;
  check("create command open -> id", Number.isInteger(cid));
  check("result not ready", (await req(server, "GET", `/api/result/${cid}`)).json.ready === false);

  // Agent side needs key
  check("agent next without key -> 401", (await req(server, "GET", "/api/command/next")).status === 401);
  check("agent next wrong key -> 401",
    (await req(server, "GET", "/api/command/next", { headers: { "X-Agent-Key": "nope" } })).status === 401);

  r = await req(server, "GET", "/api/command/next", { headers: AKEY });
  check("agent receives command 2", r.json.command && r.json.command.tool_no === 2 && r.json.command.id === cid);
  check("no second pending command",
    (await req(server, "GET", "/api/command/next", { headers: AKEY })).json.command === null);

  await req(server, "POST", "/api/result",
    { headers: AKEY, body: { command_id: cid, content_type: "json", data: JSON.stringify({ total_cpu_percent: 12.3 }) } });
  r = await req(server, "GET", `/api/result/${cid}`);
  check("result ready + content", r.json.ready === true && r.json.content_type === "json");
  check("result auto-removed after read", (await req(server, "GET", `/api/result/${cid}`)).json.ready === false);

  // Validation + manual remove
  check("tool_no 9 -> 400", (await req(server, "POST", "/api/command", { body: { tool_no: 9 } })).status === 400);
  r = await req(server, "POST", "/api/result", { headers: AKEY, body: { command_id: 1, content_type: "x", data: "y" } });
  check("post result bad content_type -> 400", r.status === 400);
  const a = (await req(server, "POST", "/api/command", { body: { tool_no: 1 } })).json.command_id;
  check("delete one -> removed 1", (await req(server, "DELETE", `/api/command/${a}`)).json.removed === 1);
  check("clear queue -> ok", (await req(server, "POST", "/api/commands/clear")).json.ok === true);

  server.close();
  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : failed + " CHECK(S) FAILED"}  (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
})();
