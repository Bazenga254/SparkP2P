"""
SparkP2P Relay Keepalive
Manages relay.py + SSH tunnel as subprocesses, auto-restarts both on failure.
Registered as a Windows startup task — runs automatically at login.
"""
import subprocess
import time
import logging
import os
import sys
from pathlib import Path

# Suppress console windows for all child processes on Windows
CREATE_NO_WINDOW = 0x08000000

RELAY_DIR   = Path(__file__).parent
LOG_FILE    = RELAY_DIR / "relay.log"

RELAY_SECRET = "45981a1b322cd4b442cd4ffdbd9a2045feda358fdfa03273b0162ba66fd2410e"
RELAY_PORT   = 7842

VPS_HOST     = "root@157.245.175.55"
VPS_PORT     = 7843          # port exposed on VPS localhost
SSH_KEY      = str(Path.home() / ".ssh" / "id_ed25519")

PYTHON       = sys.executable  # same interpreter that runs this script

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("keepalive")


def start_relay() -> subprocess.Popen:
    env = os.environ.copy()
    env["RELAY_SECRET"] = RELAY_SECRET
    env["PORT"] = str(RELAY_PORT)
    # Always use python.exe (not pythonw.exe) so uvicorn can write to stdout
    python_exe = PYTHON.replace("pythonw.exe", "python.exe")
    log_out = open(RELAY_DIR / "relay_uvicorn.log", "a", encoding="utf-8")
    proc = subprocess.Popen(
        [python_exe, str(RELAY_DIR / "relay.py")],
        env=env,
        cwd=str(RELAY_DIR),
        stdout=log_out,
        stderr=log_out,
        creationflags=CREATE_NO_WINDOW,
    )
    logger.info("Relay started  pid=%d  port=%d", proc.pid, RELAY_PORT)
    return proc


def start_tunnel() -> subprocess.Popen:
    # SSH reverse tunnel: VPS:7843 -> localhost:7842
    proc = subprocess.Popen(
        [
            "ssh", "-N",
            "-R", f"{VPS_PORT}:127.0.0.1:{RELAY_PORT}",
            "-i", SSH_KEY,
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=3",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ConnectTimeout=15",
            VPS_HOST,
        ],
        creationflags=CREATE_NO_WINDOW,
    )
    logger.info("SSH tunnel started  pid=%d  VPS:%d -> local:%d", proc.pid, VPS_PORT, RELAY_PORT)
    return proc


def main():
    logger.info("=" * 50)
    logger.info("SparkP2P Relay Keepalive starting")
    logger.info("Relay port : %d", RELAY_PORT)
    logger.info("VPS tunnel : %s  remote port %d", VPS_HOST, VPS_PORT)
    logger.info("=" * 50)

    relay_proc  = start_relay()
    time.sleep(4)           # let relay come up before opening tunnel
    tunnel_proc = start_tunnel()

    relay_restart_delay  = 5
    tunnel_restart_delay = 10

    while True:
        time.sleep(10)

        # --- relay health check ---
        if relay_proc.poll() is not None:
            code = relay_proc.returncode
            logger.warning("Relay exited (code=%d), restarting in %ds...", code, relay_restart_delay)
            time.sleep(relay_restart_delay)
            relay_proc = start_relay()
            time.sleep(4)
            # tunnel needs relay up — restart it too
            if tunnel_proc.poll() is None:
                tunnel_proc.terminate()
            tunnel_proc = start_tunnel()

        # --- tunnel health check ---
        if tunnel_proc.poll() is not None:
            code = tunnel_proc.returncode
            logger.warning("SSH tunnel exited (code=%d), restarting in %ds...", code, tunnel_restart_delay)
            time.sleep(tunnel_restart_delay)
            tunnel_proc = start_tunnel()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Keepalive stopped by user.")
