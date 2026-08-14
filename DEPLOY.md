# Deploying the backend (Render **or** Railway)

The Node/Express backend (`server.js`) serves both the API and the web
dashboard, so one service is all you need. Both platforms are supported and
build the **same** [Dockerfile](Dockerfile), so the deployed code is identical:

| Platform | Config file                    | Read automatically from |
|----------|--------------------------------|-------------------------|
| Render   | [render.yaml](render.yaml)     | repo root (Blueprint)   |
| Railway  | [railway.json](railway.json)   | service root directory  |

Neither file interferes with the other — you can keep both committed and deploy
to one, the other, or both at the same time.

## The deployed server is Node-only

This repo holds both the Node backend and the Windows Python agent
(`agent.py`, `agent.spec`, `requirements.txt`), but **no Python is deployed**:

- The build is pinned to [Dockerfile](Dockerfile), whose base image
  `node:20-alpine` has no Python interpreter, and which copies only
  `package*.json`, `server.js`, `static/` and `templates/`.
- [.dockerignore](.dockerignore) is a deny-all allowlist (`*` plus `!` entries
  for those four), so a new file in the repo cannot reach the image by
  accident.

Pinning the builder also stops Render's and Railway's auto-detection from
seeing the Python files first and building a Python app, which fails with
*"No start command detected"*.

The agent files stay in the repo because `.github/workflows/build.yml` needs
them to build `agent.exe` on release — that runs on GitHub Actions, not on the
server, and is unaffected by any of the above.

---

## Render

1. **Create the service**
   Render dashboard → *New* → *Blueprint* → pick this repo. Render reads
   `render.yaml` and creates the `laptop-control` web service.
   If the repo root is not this folder, add `rootDir: server` under the service
   in `render.yaml`.

2. **Environment variables** — `render.yaml` already declares them:
   - `AGENT_KEY` uses `generateValue: true`, so Render generates a random
     secret. Copy it from *Environment* into the agent (see
     [Point the agent at it](#point-the-agent-at-it)).
   - `ONLINE_MS` defaults to `15000`.

   Do **not** set `PORT` — Render injects it and `server.js` reads
   `process.env.PORT` (binding to `0.0.0.0`).

3. **URL**: `https://laptop-control.onrender.com` (Render assigns it; the exact
   subdomain depends on availability).

**Free plan caveat:** the free instance spins down after ~15 minutes idle. The
next agent poll or page load triggers a cold start that takes ~30–60 s, and
polls during that window fail. Upgrade to Starter for always-on, or use
Railway.

## Railway

1. **Create the service**
   Railway dashboard → *New Project* → *Deploy from GitHub repo* → pick this
   repo. If the repo root is not this folder, set
   *Settings → Source → Root Directory* to the folder containing `server.js`.

2. **Environment variables** (*Variables* tab) — Railway has no equivalent of
   Render's `generateValue`, so set them yourself:

   | Variable    | Value                                                  |
   |-------------|--------------------------------------------------------|
   | `AGENT_KEY` | a random secret — must match `AGENT_KEY` in `agent.py`  |
   | `ONLINE_MS` | optional, default `15000`                               |

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   Again, do **not** set `PORT` — Railway injects it.

3. **Generate a public domain**
   *Settings → Networking → Public Networking → Generate Domain* →
   `https://<service>.up.railway.app`.

`railway.json` also sets a health check on `/` (60 s timeout) so a deploy only
goes live once the dashboard responds, `sleepApplication: false` (always-on),
and restart-on-failure up to 10 retries. Railway bills by usage rather than
offering a free always-on tier; the trial credit covers a service this small.

---

## Point the agent at it

`agent.py` reads both values from the environment, with the Railway domain as
the built-in default:

```python
API_BASE  = os.environ.get("API_BASE",  "https://laptop-control.up.railway.app")
AGENT_KEY = os.environ.get("AGENT_KEY", "...")
```

So switching hosts needs no code change — set `API_BASE` (and the matching
`AGENT_KEY`) in the agent's environment. To bake a different default into
`agent.exe`, edit those two lines and rebuild.

The dashboard itself needs nothing: `static/app.js` calls same-origin relative
paths (`/api/...`), so it works under whichever domain serves it.

## Production behaviour (both platforms)

`server.js` is hardened for a hosted, always-behind-a-proxy deployment:

- **Fails fast on a missing key.** With `NODE_ENV=production` (set by the
  Dockerfile), the process exits at startup if `AGENT_KEY` is still the insecure
  default — so a misconfigured deploy never goes live open.
- **Trusts the platform proxy** (`trust proxy`), so `req.ip`/`req.protocol`
  reflect the real client behind Render's/Railway's TLS terminator.
- **Health endpoint** `GET /healthz` returns `{status, uptime_secs, agents,
  pending_commands}`. Both `render.yaml` and `railway.json` probe it, and the
  Dockerfile has a container-level `HEALTHCHECK` hitting the same path.
- **Graceful shutdown.** On SIGTERM (sent on every redeploy/scale-down) the
  server stops accepting connections and drains in-flight requests, with an 8 s
  backstop before the platform's SIGKILL.
- **Never crashes on bad input.** Malformed JSON and other errors return a clean
  JSON error (no stack trace leaked); unknown routes return `404 {error}`.
- **`/execute` is opt-in.** It only proxies to a Python executor when
  `PYTHON_API` is set; otherwise it returns `501` instead of hanging. Neither
  deployment sets it, so it is inert in production by default.

## Notes

- State is in-memory (`commands` / `results` / `agents` maps), so run a single
  instance — agents and their pending commands must land on the same one, and a
  redeploy clears registered agents until they poll again. On Railway that is
  `numReplicas: 1`; on Render, leave scaling at 1 instance.
- The `/execute` route proxies to `PYTHON_API`
  (default `http://127.0.0.1:8001/api/run`), which does not exist in either
  deployment. That endpoint only works locally unless you point `PYTHON_API` at
  a reachable service.
