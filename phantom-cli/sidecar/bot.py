"""phantom-cli voice sidecar — the ears and the mouth, a pipecat pipeline the
TUI spawns. The brain (the model, its tools, its history) is the TUI's — an AI
SDK agent built like the coding agent; this process never sees a model key.

    mic → Deepgram STT → UserGate → user aggregator → Brain → AssistantTap
        → SpeakerGate → Deepgram TTS → speaker → assistant aggregator

`Brain` sits where pipecat's LLM would. Upstream hands it "the user's turn is
over" (an LLMContextFrame); it reports the text to the TUI as `turn`. The TUI
answers with `speak_start` / `speak_delta` / `speak_end` as its agent writes,
and Brain pushes that text down the pipeline exactly as an LLM would have, so
TTS, echo suppression and the speaking state all work unchanged. When the user
cuts in, pipecat's interruption stops the audio; Brain tells the TUI
`interrupted`, and the assistant aggregator — after the speaker, so it only
ever sees words that were played — reports `spoken` with what was actually
said, so the TUI's history can hold that and not the rest.

Config arrives in the environment when the TUI spawns us (see voice.ts
`sidecarEnv`); everything else rides stdin/stdout as JSON lines (protocol.py).

Targets pipecat 1.4.0 exactly (pyproject pins it): every minor pipecat release
renames something, and this file was checked against the installed API.

Run: the TUI does `uv run bot.py`; by hand, `uv run bot.py` then type
{"type":"hear","text":"hi"} and watch for {"type":"turn",...}; answer with
{"type":"speak_start","turn":"t1","step":1} {"type":"speak_delta","turn":"t1","text":"Hi there."}
{"type":"speak_end","turn":"t1"}.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime

from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    MetricsFrame,
    TextFrame,
    TranscriptionFrame,
    TTSUpdateSettingsFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.metrics.metrics import TTFBMetricsData
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_mute.base_user_mute_strategy import BaseUserMuteStrategy
from pipecat.turns.user_start.transcription_user_turn_start_strategy import (
    TranscriptionUserTurnStartStrategy,
)
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy
from pipecat.turns.user_start.wake_phrase_user_turn_start_strategy import (
    WakePhraseUserTurnStartStrategy,
    _WakeState,
)
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
    SpeechTimeoutUserTurnStopStrategy,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from protocol import Channel


# --------------------------------------------------------------------------- #
# Deepgram: the connection policy.                                             #
# --------------------------------------------------------------------------- #
# The same policy the server's Telegram bot runs (phantom-backend/telegram/
# connect.ts); a change here is a change there:
#  - a connect that gets no answer fails at CONNECT_TIMEOUT_S. api.deepgram.com
#    rotates between sites and a site can go dead from a given network
#    (github.com/orgs/deepgram/discussions/764); a normal connect is 20–50 ms.
#  - a FAILED CONNECTION is retried once, fresh DNS (`use_dns_cache=False`:
#    Deepgram rotates the name within the minute, so the retry can land
#    elsewhere). A SLOW ANSWER is never cut: that would double the wait.
#  - keep-alive: Deepgram closes an idle connection at 5 s (measured
#    2026-09-04: reused at 4.8 s, new socket at 5 s). KEEP_ALIVE_S sits under
#    that so a sentence never goes out on a socket the far end already closed.
#
# The pane hears about it ONCE: after a link has been down DOWN_AFTER_S,
# "can't reach Deepgram — retrying"; when it is back, "back". Never a line
# per attempt or per sentence.
CONNECT_TIMEOUT_S = 2.0
CONNECT_RETRIES = 1
KEEP_ALIVE_S = 4.0
DOWN_AFTER_S = 5.0


class TtsLink:
    """Whether the last TTS request reached Deepgram — the health line's
    view of the HTTP link (the STT websocket reports for itself)."""

    def __init__(self) -> None:
        self.ok = True


def tts_retry_middleware(link: TtsLink):  # noqa: ANN201 — aiohttp middleware
    """aiohttp client middleware: a connect failure is retried once (fresh
    DNS — the connector caches none). Not on a slow response: that would
    double the wait. Whether the request reached Deepgram lands in `link.ok`
    for the health line."""
    import aiohttp

    retry_on = (aiohttp.ClientConnectorError, aiohttp.ConnectionTimeoutError, aiohttp.ServerDisconnectedError)

    async def middleware(req, handler):  # noqa: ANN001, ANN202
        for attempt in range(CONNECT_RETRIES + 1):
            try:
                resp = await handler(req)
            except retry_on as e:
                if attempt < CONNECT_RETRIES:
                    logger.warning(f"{req.url.host}: {e!r} — retrying once")
                    continue
                link.ok = False
                raise
            link.ok = True
            return resp

    return middleware


def tts_session(link: TtsLink):  # noqa: ANN201 — aiohttp.ClientSession
    import aiohttp

    return aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(use_dns_cache=False, keepalive_timeout=KEEP_ALIVE_S),
        timeout=aiohttp.ClientTimeout(sock_connect=CONNECT_TIMEOUT_S),
        middlewares=(tts_retry_middleware(link),),
    )


async def health(stt, link: TtsLink, ch: Channel,
                 down_after: float = DOWN_AFTER_S, tick: float = 0.5) -> None:  # noqa: ANN001
    """Ties the two links to the pane. A link that has been down `down_after`
    seconds puts ONE line in the pane; when both links are back, one more.
    pipecat reconnects STT by itself, raising an ErrorFrame per attempt ("no
    close frame received or sent", 1011) — none of that is news, so none of
    it is shown."""
    ready = stt._connection_ready
    down_since: float | None = None
    told = False
    while True:
        await asyncio.sleep(tick)
        now = time.monotonic()
        if ready.is_set() and link.ok:
            if told:
                ch.send({"type": "warn", "message": "back — can reach Deepgram again"})
            down_since, told = None, False
            continue
        down_since = down_since if down_since is not None else now
        if not told and now - down_since >= down_after:
            ch.send({"type": "warn", "message": "can't reach Deepgram — retrying"})
            told = True


# --------------------------------------------------------------------------- #
# Config — what the TUI put in the environment.                                #
# --------------------------------------------------------------------------- #
def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _envb(name: str, default: bool = False) -> bool:
    return _env(name, "1" if default else "0").lower() in ("1", "true", "yes", "on")


def _envf(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


@dataclass
class Config:
    deepgram_key: str = ""
    voice: str = "aura-2-thalia-en"
    mic: str = ""                        # device name; "" = system default
    speaker: str = ""
    mic_muted: bool = False              # the saved mutes — restored at start
    speaker_muted: bool = False
    headphones: bool = False             # True: mic stays open while we speak
    wake: bool = False
    wake_words: list[str] = field(default_factory=lambda: ["computer"])
    wake_timeout: float = 8.0            # silence (either side) before the word is needed again
    vad_stop_secs: float = 0.4
    smart_turn: bool = True              # end-of-turn model instead of silence alone
    stt_model: str = "nova-3"
    language: str = "en"


def config_from_env() -> Config:
    words = [w.strip() for w in _env("PHANTOM_CLI_VOICE_WAKE_WORDS", "computer").split(",") if w.strip()]
    return Config(
        deepgram_key=_env("DEEPGRAM_API_KEY"),
        voice=_env("PHANTOM_CLI_VOICE_VOICE", "aura-2-thalia-en"),
        mic=_env("PHANTOM_CLI_VOICE_MIC"),
        speaker=_env("PHANTOM_CLI_VOICE_SPEAKER"),
        mic_muted=_envb("PHANTOM_CLI_VOICE_MIC_MUTED"),
        speaker_muted=_envb("PHANTOM_CLI_VOICE_SPEAKER_MUTED"),
        headphones=_envb("PHANTOM_CLI_VOICE_HEADPHONES"),
        wake=_envb("PHANTOM_CLI_VOICE_WAKE"),
        wake_words=words or ["computer"],
        wake_timeout=_envf("PHANTOM_CLI_VOICE_WAKE_TIMEOUT", 8.0),
        vad_stop_secs=_envf("PHANTOM_CLI_VOICE_VAD_STOP", 0.4),
        smart_turn=_envb("PHANTOM_CLI_VOICE_SMART_TURN", True),
        stt_model=_env("PHANTOM_CLI_VOICE_STT_MODEL", "nova-3"),
        language=_env("PHANTOM_CLI_VOICE_LANGUAGE", "en"),
    )


# --------------------------------------------------------------------------- #
# Audio devices — by NAME, never by index: indexes change between reboots.     #
# --------------------------------------------------------------------------- #
def list_devices(pa) -> dict[str, list[str]]:  # noqa: ANN001 (pyaudio.PyAudio)
    mics: list[str] = []
    speakers: list[str] = []
    for i in range(pa.get_device_count()):
        d = pa.get_device_info_by_index(i)
        name = str(d.get("name", ""))
        if int(d.get("maxInputChannels", 0)) > 0 and name not in mics:
            mics.append(name)
        if int(d.get("maxOutputChannels", 0)) > 0 and name not in speakers:
            speakers.append(name)
    return {"mics": mics, "speakers": speakers}


def device_index(pa, name: str, kind: str) -> int | None:  # noqa: ANN001
    """The first device whose name matches `name` (exact, then case-insensitive
    contains) and has channels of `kind` ("in" | "out"). None = let PortAudio
    pick the system default — also what a missing or unplugged name gets."""
    if not name:
        return None
    key = "maxInputChannels" if kind == "in" else "maxOutputChannels"
    candidates = []
    for i in range(pa.get_device_count()):
        d = pa.get_device_info_by_index(i)
        if int(d.get(key, 0)) > 0:
            candidates.append((i, str(d.get("name", ""))))
    for i, n in candidates:
        if n == name:
            return i
    for i, n in candidates:
        if name.lower() in n.lower():
            return i
    return None


# --------------------------------------------------------------------------- #
# Shared state the gates and the mute strategy read.                           #
# --------------------------------------------------------------------------- #
ECHO_TAIL_S = 1.2   # after our audio ends, how long the mic still hears us (buffer + STT lag)
ECHO_MIN_WORDS = 3  # shorter transcripts are not judged against our last reply


def normalize_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def is_echo_of(transcript: str, reply: str) -> bool:
    """Is `transcript` just a run of `reply` (our own last words coming back
    through the mic)? Word-level containment after normalising case and
    punctuation; very short transcripts are left alone — "yes" is not echo."""
    t = normalize_words(transcript)
    r = normalize_words(reply)
    if len(t) < ECHO_MIN_WORDS or len(r) < len(t):
        return False
    joined = " " + " ".join(r) + " "
    return (" " + " ".join(t) + " ") in joined


@dataclass
class State:
    headphones: bool
    mic_muted: bool = False
    speaker_muted: bool = False
    bot_speaking: bool = False
    bot_stopped_at: float = -1e9        # monotonic time our audio last ended
    echo_utterance: bool = False        # the utterance in progress began while we spoke
    last_reply: str = ""                # what we last said, for is_echo_of

    def speaking_or_tail(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        return self.bot_speaking or (now - self.bot_stopped_at) < ECHO_TAIL_S

    def user_suppressed(self, now: float | None = None) -> bool:
        """Nothing the mic hears counts right now: muted; or, over speakers,
        we are speaking / just stopped (the mic still hears our tail) / the
        utterance started while we were speaking — it is us, not the user."""
        if self.mic_muted:
            return True
        if self.headphones:
            return False
        return self.speaking_or_tail(now) or self.echo_utterance

    def on_bot_started(self) -> None:
        self.bot_speaking = True

    def on_bot_stopped(self) -> None:
        self.bot_speaking = False
        self.bot_stopped_at = time.monotonic()

    def on_user_started(self) -> None:
        """A new utterance: it is echo if it begins while we speak or in the tail."""
        self.echo_utterance = (not self.headphones) and self.speaking_or_tail()


class LiveWakeStrategy(WakePhraseUserTurnStartStrategy):
    """pipecat's wake-phrase gate, switchable and re-wordable while running.
    Always first in the start strategies; when off it just lets every frame
    through (CONTINUE) as if always awake, so turning the wake word on or off
    in /voice is a message, not an engine restart."""

    def __init__(self, *, phrases: list[str], enabled: bool, timeout: float = 8.0) -> None:
        super().__init__(phrases=phrases, timeout=timeout)
        self.enabled = enabled

    def set_phrases(self, phrases: list[str]) -> None:
        self._phrases = phrases
        self._patterns = [
            re.compile(r"\b" + r"\s*".join(re.escape(w) for w in p.split()) + r"\b", re.IGNORECASE)
            for p in phrases
        ]

    def set_enabled(self, enabled: bool) -> None:
        if enabled and not self.enabled:
            self._state = _WakeState.IDLE   # start gated: the word has to be said first
        self.enabled = enabled

    # Called (throttled by run()) each time the awake clock restarts — any
    # activity resets it to the full window, so the TUI's countdown follows.
    on_refresh = None

    def set_timeout(self, secs: float) -> None:
        """The awake window, live. pipecat's timer task re-reads _timeout each
        time it re-arms; poking the event makes it re-arm now, so the new
        length applies at once rather than after the old one runs out."""
        if secs > 0:
            self._timeout = secs
            self._refresh_timeout()

    def _refresh_timeout(self) -> None:
        super()._refresh_timeout()
        if self.enabled and self._state == _WakeState.AWAKE and self.on_refresh:
            self.on_refresh()

    async def process_frame(self, frame: Frame):  # noqa: ANN201 (ProcessFrameResult)
        if not self.enabled:
            await BaseUserTurnStartStrategy.process_frame(self, frame)
            return ProcessFrameResult.CONTINUE
        return await super().process_frame(frame)


class AppMuteStrategy(BaseUserMuteStrategy):
    """pipecat's own mute hook, driven by `State`: while it returns True the user
    aggregator drops what the mic produces (no turn starts, no interruption)."""

    def __init__(self, state: State) -> None:
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame) -> bool:
        await super().process_frame(frame)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._state.on_bot_started()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._state.on_bot_stopped()
        elif isinstance(frame, (UserStartedSpeakingFrame, VADUserStartedSpeakingFrame)):
            self._state.on_user_started()
        return self._state.user_suppressed()


# --------------------------------------------------------------------------- #
# Pipeline taps.                                                               #
# --------------------------------------------------------------------------- #
class UserGate(FrameProcessor):
    """Right after STT. Reports what the user said (partials too, for the
    sidebar) and drops it while the user is suppressed — so our own voice, or a
    muted mic, never shows up as something the user said. Also the place
    speaking/listening state is reported: bot speaking frames pass here on
    their way upstream."""

    def __init__(self, ch: Channel, state: State, wake: "LiveWakeStrategy") -> None:
        super().__init__()
        self._ch = ch
        self._state = state
        self._wake = wake

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._state.on_bot_started()
            self._ch.send({"type": "status", "speaking": True})
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._state.on_bot_stopped()
            self._ch.send({"type": "status", "speaking": False})
        elif isinstance(frame, (UserStartedSpeakingFrame, VADUserStartedSpeakingFrame)):
            self._state.on_user_started()
            if isinstance(frame, UserStartedSpeakingFrame) and not self._state.user_suppressed():
                self._ch.send({"type": "status", "hearing": True})
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._ch.send({"type": "status", "hearing": False})
        elif isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame)):
            if self._state.user_suppressed():
                return
            # Our own last words coming back through the mic, whatever the
            # timing: drop them before they become a turn.
            if not self._state.headphones and is_echo_of(frame.text, self._state.last_reply):
                logger.debug(f"dropping echo of our reply: {frame.text!r}")
                return
            # Wake on and the window closed: nothing said now can become a
            # turn, so it must not paint as the user's line either. Only the
            # REPORT is skipped — the frame still flows on, because the gate
            # downstream is what hears the wake word; the waking utterance
            # then arrives whole as the committed `turn`.
            if not (self._wake.enabled and self._wake.state != _WakeState.AWAKE):
                self._ch.send({"type": "user", "text": frame.text, "final": isinstance(frame, TranscriptionFrame)})
        await self.push_frame(frame, direction)


class Brain(FrameProcessor):
    """Where pipecat's LLM would be. The turn-taking upstream decides when the
    user is done and hands down the context; this reports the user's text to
    the TUI (`turn`) and swallows the frame — nothing downstream needs it. The
    TUI's agent answers through speak_start/delta/end, which push the same
    frames an LLM pushes (LLMFullResponseStart / LLMText / LLMFullResponseEnd),
    so the rest of the pipeline cannot tell the difference.

    Interruption: pipecat broadcasts InterruptionFrame when the user cuts in
    (or on `cancel`); the turn being spoken is marked dead — later deltas for
    it are dropped (the TUI's abort is on its way but a few may still arrive)
    — and the TUI is told `interrupted`. `speak_start`s are queued in order so
    the assistant aggregator's turn events (at the very end of the pipeline,
    after the audio) can be matched back to (turn, step) — see `spoken_id`."""

    def __init__(self, ch: Channel) -> None:
        super().__init__()
        self._ch = ch
        self._dead: set[str] = set()
        self._cur: str | None = None          # the turn a speak_start opened, until its speak_end
        self._pending: list[tuple[str, int]] = []   # (turn, step) of LLMFullResponseStartFrames pushed, not yet started downstream
        self._spoken: list[tuple[str, int]] = []    # the ones the assistant aggregator has started, in order

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            msgs = frame.context.get_messages()
            last = msgs[-1] if msgs else None
            text = last.get("content") if isinstance(last, dict) and last.get("role") == "user" else None
            if isinstance(text, str) and text.strip():
                self._ch.send({"type": "turn", "text": text.strip()})
            return   # consumed
        if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
            if self._cur is not None:
                self._dead.add(self._cur)
            self._pending.clear()
            self._ch.send({"type": "interrupted", **({"turn": self._cur} if self._cur else {})})
        await self.push_frame(frame, direction)

    async def interrupt(self) -> None:
        """`cancel` from the TUI: stop what is being said, now. Broadcast from
        HERE, below the user aggregator — a frame queued at the top of the
        pipeline is swallowed by the user-mute strategy while we speak over
        speakers (the mic counts as muted then), which is exactly when you
        want to cancel. Downstream it reaches TTS, the speaker and the
        assistant aggregator (→ `spoken` with what got through); upstream it
        is the aggregator's to mute or not."""
        if self._cur is not None:
            self._dead.add(self._cur)
        self._pending.clear()
        self._ch.send({"type": "interrupted", **({"turn": self._cur} if self._cur else {})})
        await self.broadcast_interruption()

    # --- what the TUI's agent says, into the pipeline ---------------------------
    async def speak_start(self, turn: str, step: int) -> None:
        if turn in self._dead:
            return
        self._cur = turn
        self._pending.append((turn, step))
        await self.push_frame(LLMFullResponseStartFrame())

    async def speak_delta(self, turn: str, text: str) -> None:
        if turn in self._dead or not text:
            return
        await self.push_frame(LLMTextFrame(text=text))

    async def speak_end(self, turn: str) -> None:
        if turn in self._dead:
            return
        if self._cur == turn:
            self._cur = None
        await self.push_frame(LLMFullResponseEndFrame())

    # --- matching the assistant aggregator's events back to (turn, step) ------------
    def assistant_started(self) -> None:
        """The aggregator opened an assistant turn: it is the oldest pending one."""
        if self._pending:
            self._spoken.append(self._pending.pop(0))

    def assistant_stopped(self) -> tuple[str, int] | None:
        """The aggregator closed an assistant turn: the oldest started one."""
        return self._spoken.pop(0) if self._spoken else None


class AssistantTap(FrameProcessor):
    """Right after Brain. Keeps what we are saying (for echo suppression —
    `State.last_reply`) and forwards the timing numbers to the TUI."""

    def __init__(self, ch: Channel, state: State | None = None) -> None:
        super().__init__()
        self._ch = ch
        self._state = state or State(headphones=True)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._state.last_reply = ""
        elif isinstance(frame, LLMTextFrame):
            self._state.last_reply += frame.text
        elif isinstance(frame, MetricsFrame):
            for d in frame.data:
                if isinstance(d, TTFBMetricsData):
                    self._ch.send({"type": "metrics", "processor": d.processor, "ttfb_ms": round(d.value * 1000)})
        await self.push_frame(frame, direction)


class SpeakerGate(FrameProcessor):
    """Right before TTS. With the speaker muted, text is marked `skip_tts`: the
    TTS service passes it through unspoken, and the assistant aggregator after
    the transport still records the reply — text keeps streaming, audio stops."""

    def __init__(self, state: State) -> None:
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if self._state.speaker_muted and isinstance(
            frame, (TextFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame)
        ) and not isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame)):
            frame.skip_tts = True
        await self.push_frame(frame, direction)


def make_turn_stop(cfg: Config) -> tuple[list, float, str]:
    """How the user's turn ends: (stop strategies, VAD stop_secs, a label).

    Smart-turn (pipecat's bundled end-of-turn model, smart-turn v3, ~30 ms on
    CPU, no download) judges from the speech itself whether the user is done,
    so the silence wait can be the recommended 0.2 s without cutting people
    off mid-thought; it still ends a turn after `stop_secs` of silence if the
    model keeps saying "not done". Silence alone (`cfg.vad_stop_secs`) is the
    fallback — when switched off, or if the model cannot load."""
    if cfg.smart_turn:
        try:
            from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
            from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
            from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import (
                TurnAnalyzerUserTurnStopStrategy,
            )
            analyzer = LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=2.0))
            return [TurnAnalyzerUserTurnStopStrategy(turn_analyzer=analyzer)], 0.2, "smart-turn-v3"
        except Exception as e:  # noqa: BLE001 — the model is an improvement, never a requirement
            logger.warning(f"smart-turn unavailable ({e}); ending turns on silence")
    return [SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=cfg.vad_stop_secs)], cfg.vad_stop_secs, "silence"


# --------------------------------------------------------------------------- #
# Main.                                                                        #
# --------------------------------------------------------------------------- #
def claim_stdout():  # noqa: ANN201 — a text file object
    """Take fd 1 for the protocol and nothing else. C libraries (PortAudio's
    CoreAudio host printed an `||PaMacCore|| Error` line straight onto fd 1 in
    testing) write to the real fd 1, so: keep a private duplicate of it for
    our JSON lines and point fd 1 at stderr, where stray prints become log."""
    keep = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(keep, "w", buffering=1, encoding="utf-8")


async def main() -> None:
    logger.remove()
    logger.add(sys.stderr, level=_env("PHANTOM_CLI_VOICE_LOG_LEVEL", "INFO"))
    ch = _channel()
    cfg = config_from_env()
    inbox: asyncio.Queue = asyncio.Queue()
    ch.start_reader(inbox.put_nowait, lambda: inbox.put_nowait({"type": "shutdown"}))

    if not cfg.deepgram_key:
        ch.send({"type": "error", "message": "voice needs a deepgram key — set it on /keys"})
        return

    import aiohttp
    import pyaudio
    from pipecat.services.deepgram.stt import DeepgramSTTService, LiveOptions
    from pipecat.services.deepgram.tts import DeepgramHttpTTSService
    from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams

    pa = pyaudio.PyAudio()
    devices = list_devices(pa)
    in_idx = device_index(pa, cfg.mic, "in")
    out_idx = device_index(pa, cfg.speaker, "out")
    pa.terminate()

    state = State(headphones=cfg.headphones, mic_muted=cfg.mic_muted, speaker_muted=cfg.speaker_muted)

    transport = LocalAudioTransport(LocalAudioTransportParams(
        audio_in_enabled=True, audio_out_enabled=True,
        input_device_index=in_idx, output_device_index=out_idx,
    ))
    stt = DeepgramSTTService(
        api_key=cfg.deepgram_key,
        # profanity_filter=False must be explicit: pipecat's default is True
        # (Deepgram's own API default is False) and it was starring out words.
        live_options=LiveOptions(model=cfg.stt_model, language=cfg.language,
                                 smart_format=True, interim_results=True,
                                 profanity_filter=False),
    )
    brain = Brain(ch)
    # HTTP, not the websocket service, on purpose. `spoken` is built from the
    # text frames the TTS emits, once they have passed the speaker. The
    # websocket service emits each sentence's text the instant the sentence
    # is SENT (its audio arrives later on the receive side), so on an
    # interruption "spoken" would be everything generated so far, not what
    # was heard. The HTTP service fetches a sentence's audio inside run_tts
    # and emits the text after it, so the text passes the speaker only when
    # that sentence has played — measured on this Mac 2026-08-23: cut off at
    # 3 s into a 5-sentence reply, websocket reports all 5, HTTP reports the
    # 1 that had finished. Cost: ~0.15–0.3 s more to the first audio of a
    # reply (one request per sentence, keep-alive). Timeouts and the one
    # retry: `tts_session` at the top of the file.
    link = TtsLink()
    http = tts_session(link)
    tts = DeepgramHttpTTSService(api_key=cfg.deepgram_key, voice=cfg.voice, aiohttp_session=http)

    # pipecat's own context: only the aggregators read it (the user aggregator
    # writes the turn it hands Brain; the assistant aggregator writes what was
    # spoken). The conversation that matters is the TUI's.
    context = LLMContext(messages=[])

    # Turn taking. Start: the wake phrase first when wake is on (it blocks the
    # rest until heard), then VAD (interrupting us only with headphones on —
    # over speakers the VAD would hear us and cut us off), then a final
    # transcript. Stop: a short silence after the last word.
    wake = LiveWakeStrategy(phrases=cfg.wake_words, enabled=cfg.wake, timeout=cfg.wake_timeout)

    # The awake window, for the pane's recording mark. Waking and every
    # activity restart the clock to the full window (on_refresh — it also
    # fires on the wake itself), so the TUI gets the deadline and counts it
    # down locally; at most one deadline a second, because activity frames
    # arrive far faster than that. The lapse is pipecat's own timeout event.
    _wake_notified = 0.0

    def _on_wake_refresh() -> None:
        nonlocal _wake_notified
        now = time.monotonic()
        if now - _wake_notified >= 1.0:
            _wake_notified = now
            ch.send({"type": "status", "awake": True, "awake_secs": wake._timeout})
    wake.on_refresh = _on_wake_refresh

    @wake.event_handler("on_wake_phrase_timeout")
    async def _on_wake_timeout(_w) -> None:  # noqa: ANN001
        ch.send({"type": "status", "awake": False})

    # Kept by name: `set headphones` flips its interruptions while running. The
    # flag is read each time a turn start triggers, not at pipeline build
    # (checked against the installed 1.4.0; test_sidecar pins the read), so the
    # flip is a message, not a restart — same deal as the wake gate.
    vad_start = VADUserTurnStartStrategy(enable_interruptions=cfg.headphones)
    start = [
        wake,   # always present; off = pass-through — so /voice can flip it live
        vad_start,
        TranscriptionUserTurnStartStrategy(use_interim=False),
    ]
    stop, vad_stop, turn_label = make_turn_stop(cfg)
    logger.info(f"turn end: {turn_label} (vad stop {vad_stop}s)")
    aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(
                stop_secs=vad_stop, start_secs=0.2, confidence=0.7, min_volume=0.6)),
            user_turn_strategies=UserTurnStrategies(start=start, stop=stop),
            user_mute_strategies=[AppMuteStrategy(state)],
        ),
    )

    # The assistant aggregator sits after the speaker, so the text it collects
    # is what was actually played: in full, or up to the interruption. Matched
    # back to the TUI's (turn, step) through Brain's queue.
    @aggregator.assistant().event_handler("on_assistant_turn_started")
    async def _on_assistant_started(_agg) -> None:  # noqa: ANN001
        brain.assistant_started()

    @aggregator.assistant().event_handler("on_assistant_turn_stopped")
    async def _on_assistant_stopped(_agg, m) -> None:  # noqa: ANN001
        ref = brain.assistant_stopped()
        if ref is None:
            return
        ch.send({"type": "spoken", "turn": ref[0], "step": ref[1], "text": m.content or "",
                 "interrupted": bool(m.interrupted)})

    pipeline = Pipeline([
        transport.input(),
        stt,
        UserGate(ch, state, wake),
        aggregator.user(),
        brain,
        AssistantTap(ch, state),
        SpeakerGate(state),
        tts,
        transport.output(),
        aggregator.assistant(),
    ])
    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        # The TUI keeps us alive for the whole session, silent for long
        # stretches — pipecat would otherwise cancel the pipeline after 300s.
        cancel_on_idle_timeout=False,
    )

    async def inbox_loop() -> None:
        while True:
            msg = await inbox.get()
            t = msg.get("type")
            try:
                if t == "speak_start":
                    await brain.speak_start(str(msg.get("turn", "")), int(msg.get("step", 0)))
                elif t == "speak_delta":
                    await brain.speak_delta(str(msg.get("turn", "")), str(msg.get("text", "")))
                elif t == "speak_end":
                    await brain.speak_end(str(msg.get("turn", "")))
                elif t == "hear":
                    # Test seam: as if the mic heard this — the real turn-taking
                    # path (aggregator, interruption), no microphone needed.
                    text = str(msg.get("text", "")).strip()
                    if text:
                        from pipecat.frames.frames import UserStartedSpeakingFrame as _Start
                        from pipecat.frames.frames import UserStoppedSpeakingFrame as _Stop
                        from pipecat.frames.frames import VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame
                        await task.queue_frames([
                            VADUserStartedSpeakingFrame(), _Start(),
                            TranscriptionFrame(text=text, user_id="tui", timestamp=datetime.now().isoformat()),
                            VADUserStoppedSpeakingFrame(), _Stop(),
                        ])
                elif t == "devices":
                    # Re-scan: a fresh PyAudio sees devices plugged in since start.
                    pa2 = pyaudio.PyAudio()
                    try:
                        ch.send({"type": "devices", "devices": list_devices(pa2)})
                    finally:
                        pa2.terminate()
                elif t == "mic":
                    state.mic_muted = bool(msg.get("muted"))
                    ch.send({"type": "status", "mic_muted": state.mic_muted})
                elif t == "speaker":
                    state.speaker_muted = bool(msg.get("muted"))
                    ch.send({"type": "status", "speaker_muted": state.speaker_muted})
                elif t == "set":
                    if msg.get("voice"):
                        await task.queue_frames([TTSUpdateSettingsFrame(settings={"voice": str(msg["voice"])})])
                    if "wake_words" in msg:
                        words = [w.strip() for w in str(msg["wake_words"]).split(",") if w.strip()]
                        wake.set_phrases(words or ["computer"])
                    if "wake_timeout" in msg:
                        try:
                            wake.set_timeout(float(msg["wake_timeout"]))
                        except (TypeError, ValueError):
                            pass
                    if "wake" in msg:
                        wake.set_enabled(bool(msg["wake"]))
                        # The gate's actual state, not an assumption: a re-send
                        # with wake already on (a reword) must not clear the
                        # pane's recording mark while the window is still open.
                        ch.send({"type": "status", "wake": wake.enabled,
                                 "awake": wake.enabled and wake.state.name == "AWAKE",
                                 "awake_secs": wake._timeout})
                    if "headphones" in msg:
                        state.headphones = bool(msg["headphones"])
                        vad_start._enable_interruptions = state.headphones
                        ch.send({"type": "status", "headphones": state.headphones})
                elif t == "cancel":
                    await brain.interrupt()
                elif t == "shutdown":
                    logger.info("shutdown — cancelling pipeline")
                    await task.cancel()
                    return
                else:
                    logger.warning(f"unknown message {t!r}")
            except Exception as e:  # noqa: BLE001 — one bad message must not kill the loop
                logger.warning(f"message {t!r} failed: {e}")
                ch.send({"type": "error", "message": f"{t}: {e}"})

    inbox_task = asyncio.create_task(inbox_loop())
    health_task = asyncio.create_task(health(stt, link, ch))

    # `ready` only once the pipeline is actually running: a speak_* that
    # arrives before the StartFrame has reached Brain is refused by pipecat
    # ("StartFrame not received yet"), and the TUI may well answer a typed
    # /say the instant it sees ready.
    @task.event_handler("on_pipeline_started")
    async def _on_started(_task, _frame) -> None:  # noqa: ANN001
        ch.send({"type": "ready", "devices": devices, "mic": cfg.mic or "", "speaker": cfg.speaker or "",
                 "voice": cfg.voice, "turn": turn_label,
                 "mic_muted": state.mic_muted, "speaker_muted": state.speaker_muted,
                 "headphones": state.headphones, "wake": wake.enabled})

    runner = PipelineRunner(handle_sigint=True)
    try:
        await runner.run(task)
    finally:
        inbox_task.cancel()
        health_task.cancel()
        await http.close()
    logger.info("pipeline ended — exiting")


_OUT = None  # the protocol's stdout, once claimed — so a fatal error still reaches the TUI


def _channel() -> Channel:
    global _OUT
    if _OUT is None:
        _OUT = claim_stdout()
    return Channel(out=_OUT)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:  # noqa: BLE001 — report, then die loudly
        _channel().send({"type": "error", "message": str(e)})
        logger.exception("fatal")
        sys.exit(1)
    os._exit(0)
