"""The wire between the TUI and this process: one JSON object per line.

stdin  — what the TUI sends (speak_start/speak_delta/speak_end, mic, speaker,
         set, cancel, devices, shutdown; `hear` as a test seam).
stdout — what this process reports (ready, status, user, turn, interrupted,
         spoken, metrics, devices, error).
stderr — logs, and only logs. Nothing else may write to stdout: one stray
         print() and the TUI reads garbage.
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from collections.abc import Callable
from typing import Any

def parse_line(line: str) -> dict[str, Any] | None:
    """One line of stdin → a message, or None for blank/garbage (logged by the
    caller). Pure, so it can be tested without a pipe."""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) and isinstance(obj.get("type"), str) else None


def encode(msg: dict[str, Any]) -> str:
    """A message → the exact bytes that go on the wire (with its newline)."""
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n"


class Channel:
    """stdout writer + stdin reader."""

    def __init__(self, out=None, inp=None) -> None:
        self._out = out or sys.stdout
        self._in = inp or sys.stdin
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    # --- out ---------------------------------------------------------------
    def send(self, msg: dict[str, Any]) -> None:
        data = encode(msg)
        with self._lock:
            self._out.write(data)
            self._out.flush()

    # --- in ----------------------------------------------------------------
    def start_reader(self, on_message: Callable[[dict[str, Any]], Any], on_eof: Callable[[], Any]) -> None:
        """Read stdin on a thread (blocking readline), dispatch on the event
        loop. EOF — the TUI went away — is reported once."""
        loop = asyncio.get_running_loop()
        self._loop = loop

        def run() -> None:
            for line in self._in:
                msg = parse_line(line)
                if msg is None:
                    continue
                loop.call_soon_threadsafe(lambda m=msg: asyncio.ensure_future(_maybe_await(on_message(m))))
            loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_maybe_await(on_eof())))

        threading.Thread(target=run, name="stdin-reader", daemon=True).start()


async def _maybe_await(v: Any) -> Any:
    if asyncio.iscoroutine(v):
        return await v
    return v
