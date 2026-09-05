# phantom-cli/sidecar/ — the voice process

The Assistant's ears and mouth: a Python (pipecat 1.4) pipeline the app
spawns and talks to over stdin/stdout JSON lines. It never sees the model or
its key — the brain is in the app (`voice.ts`); the app never touches audio.

```
bot.py           the pipeline: mic → Deepgram STT → gates → Brain → Deepgram TTS (HTTP) → speaker; the wire loop
protocol.py      JSON lines: parse_line (a line without a string `type` is dropped silently), encode, Channel
devices.py       prints mics/speakers as one JSON line — the /voice pickers while voice is off
pyproject.toml   pins pipecat-ai[deepgram,silero,local]==1.4.0, Python 3.11–3.13; uv.lock is committed, .venv is not
test_sidecar.py  offline tests, Brain inside a real pipeline included
(cd phantom-cli/sidecar && uv run python -m unittest test_sidecar -v)
```

`uv` is the only requirement: the app finds it (`~/.phantom-cli/bin`,
`~/.local/bin`, brew, PATH) or downloads the pinned release after a sha256
check; `uv sync --frozen` runs on every start (~100ms after the first).
PyAudio's wheel ships PortAudio — no brew.

## The wire

App → sidecar: `speak_start {turn, step}` · `speak_delta {turn, text}` ·
`speak_end {turn}` · `mic {muted}` · `speaker {muted}` · `set {voice?,
wake?, wake_words?, wake_timeout?, headphones?}` · `cancel` · `devices` ·
`shutdown` · `hear {text}` (test seam).

Sidecar → app: `ready {devices, mic, speaker, voice, mic_muted, speaker_muted,
headphones, wake, turn}` · `status {speaking?, hearing?, mic_muted?,
speaker_muted?, headphones?, wake?, awake?, awake_secs?}` · `user {text, final}` (for the eye) · `turn
{text}` (the aggregated turn — what the app answers) · `interrupted
{turn?}` · `spoken {turn, step, text, interrupted}` · `metrics {processor,
ttfb_ms}` · `devices {devices}` · `warn {message}` (Deepgram unreachable for
over 5 s — one line — and one more when it is back; never a line per
attempt or per sentence; the status untouched) · `error {message}` (the
engine giving up).

- `ready` is sent from `on_pipeline_started`, never before `runner.run`, or
  an immediate `speak_*` is refused ("StartFrame not received yet"). It
  reports both modes and the device NAMES found (devices are chosen by name;
  indexes change between reboots).
- Nothing else may write to stdout — PortAudio's C code does — so `bot.py`
  moves fd 1 to stderr at start and keeps a private duplicate for the
  protocol (`claim_stdout`).
- `hear` queues VAD/transcription frames as if the mic heard the text: the
  turn-taking seam (`say` bypasses the aggregator). Under smart-turn a heard
  turn ends at the silence ceiling because no audio follows.

Spawn env (written by `voice.ts`): `DEEPGRAM_API_KEY`,
`PHANTOM_CLI_VOICE_VOICE / _MIC / _SPEAKER / _STT_MODEL (the
`voice_stt_model` server setting — the same model Telegram voice notes are
heard with) / _MIC_MUTED / _SPEAKER_MUTED / _HEADPHONES / _WAKE /
_WAKE_WORDS / _WAKE_TIMEOUT`. Operator-only knobs the app never sets:
`PHANTOM_CLI_VOICE_VAD_STOP` (0.4), `_SMART_TURN` (on), `_LANGUAGE` (en),
`_LOG_LEVEL` (INFO).

## Behaviour that was paid for

- **Brain is the LLM slot.** `turn` out; `speak_start/delta/end` pushed into
  the pipeline exactly as an LLM's frames would be. When the user cuts in,
  pipecat's interruption stops the audio, Brain sends `interrupted`, and the
  assistant aggregator — placed AFTER the speaker, so it only sees words
  that were played — sends `spoken`. `cancel` is `Brain.interrupt()`, an
  interruption broadcast from BELOW the user aggregator: a frame queued at
  the top is swallowed by the mute strategy while the Assistant speaks over
  speakers, which is exactly when you cancel.
- **The Deepgram connection policy** (`tts_retry_middleware`, `tts_session`,
  `health`) — the same one the server's Telegram bot runs
  (`phantom-backend/telegram/connect.ts`); change one, change the other.
  `api.deepgram.com` is a short-TTL CNAME rotated between sites, and a site
  can go dead from a given network. So: a connect with no answer fails at
  `CONNECT_TIMEOUT_S` (2 s — the slow live site needs ~1 s, so 0.5 s is too
  short) and is retried once with fresh DNS (`use_dns_cache=False`, so the
  retry can land on another site); a SLOW ANSWER is never cut; an idle
  socket is dropped at `KEEP_ALIVE_S` (4 s) because Deepgram closes idle
  connections at 5 s (measured 2026-09-04) and a sentence must never go
  out on one the far end already closed. No address is remembered or
  pinned: that bypassed Deepgram's own routing and carried state
  (tried and removed). The pane: one line after `DOWN_AFTER_S` (5 s)
  unreachable, one line when back. pipecat reconnects STT by itself,
  raising an ErrorFrame per attempt ("no close frame received or sent",
  1011) — none of that reaches the pane. pipecat's `_connection_ready` is
  pinned by a test.
- **TTS is Deepgram over HTTP, not the websocket, because of `spoken`.**
  The websocket service emits a sentence's text the instant it is SENT, so
  a cut-off would report everything generated. `DeepgramHttpTTSService`
  fetches a sentence's audio inside `run_tts` and emits the text after it,
  so `spoken` holds only sentences that played. Cost ~0.15–0.3s to first
  audio.
- **Two mutes, and why `headphones` exists.** `mic` drops what is heard
  (`UserGate` + `AppMuteStrategy`); `speaker` marks reply text `skip_tts`
  before TTS — text still streams and is still recorded. With headphones
  OFF the mic counts as muted while the Assistant speaks and VAD may not
  interrupt (over speakers the mic hears the Assistant); ON keeps it open.
  The headphones flip sets `State.headphones` AND the VAD start strategy's
  `_enable_interruptions`, which pipecat reads per trigger — pinned by a
  test on 1.4.0.
- **Echo over speakers is three guards:** the mute holds `ECHO_TAIL_S`
  after speech ends; an utterance whose VAD start fell inside
  speaking-or-tail is dropped whole (`State.echo_utterance`); a transcript
  of 3+ words that is a run of the agent's last reply is dropped
  (`is_echo_of`, `State.last_reply` via `AssistantTap`). Cost: ~1.2s after
  it stops talking is not yours.
- **Wake word** is `LiveWakeStrategy`, always in the pipeline and switched
  by `set`; while awake the sidecar pushes `status {awake, awake_secs}` at
  most once a second; only AUDIBLE speech refreshes the window (a muted
  speaker does not extend it).
- **Turns end on smart-turn, silence is the fallback.** pipecat 1.4 bundles
  smart-turn v3 (CPU, ~30ms load, no download — NOT an extra);
  `make_turn_stop` uses it with VAD silence 0.2s and a 2s ceiling;
  `PHANTOM_CLI_VOICE_SMART_TURN=0` or a load failure → silence at
  `vad_stop_secs`. `ready.turn` says which.
- **pipecat is pinned at 1.4.0 and the bot was checked against the installed
  API**, not the docs (1.4 moved VAD into `LLMUserAggregatorParams`, built
  in wake and mute strategies, deprecated-but-kept `PipelineTask`/
  `LiveOptions`/`InputParams`). Every minor renames something; bump on
  purpose with `test_sidecar.py` and a live `hear` run.
