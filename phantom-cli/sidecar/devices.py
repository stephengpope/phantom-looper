"""Print the audio devices as JSON — so the TUI can offer a mic/speaker picker
while voice is off. One line on stdout: {"mics":[...],"speakers":[...]}.
PortAudio's host may print noise to fd 1 (see bot.claim_stdout), so the same
trick: move fd 1 to stderr, write the JSON to a private duplicate.

    uv run devices.py
"""

from __future__ import annotations

import json
import os
import sys


def main() -> None:
    keep = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    out = os.fdopen(keep, "w", encoding="utf-8")
    import pyaudio
    from bot import list_devices

    pa = pyaudio.PyAudio()
    try:
        devices = list_devices(pa)
    finally:
        pa.terminate()
    out.write(json.dumps(devices) + "\n")
    out.flush()


if __name__ == "__main__":
    main()
