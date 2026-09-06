# phantom-cli/sidecar/ — the voice process

The Assistant's ears and mouth: a Python pipecat pipeline the app spawns
and talks to over stdin and stdout JSON lines. It never sees the model or
its key; the brain is in `voice.ts`. The app never touches audio.

```
bot.py           the pipeline: mic → Deepgram STT → gates → Brain → Deepgram TTS (HTTP) → speaker, and the wire loop
protocol.py      parse_line, encode, Channel (stdout writer + threaded stdin reader)
devices.py       prints the mic and speaker names as one JSON line, for the pickers while voice is off
pyproject.toml   pipecat-ai[deepgram,silero,local]==1.4.0, Python 3.11 to 3.13; uv.lock committed, .venv not
test_sidecar.py  offline tests
(cd phantom-cli/sidecar && uv run python -m unittest test_sidecar -v)
```

`uv` is the only requirement. `voice.ts` finds it or downloads the pinned
release after a checksum, then runs `uv sync --frozen` on every start.

## The wire

App to sidecar: `speak_start {turn, step}`, `speak_delta {turn, text}`,
`speak_end {turn}`, `mic {muted}`, `speaker {muted}`, `set {voice?, wake?,
wake_words?, wake_timeout?, headphones?}`, `cancel`, `devices`,
`shutdown`, and `hear {text}` as the test seam.

Sidecar to app: `ready {devices, mic, speaker, voice, mic_muted,
speaker_muted, headphones, wake, turn}`, `status {...}`, `user {text,
final}` (for the eye), `turn {text}` (what the app answers), `interrupted
{turn?}`, `spoken {turn, step, text, interrupted}`, `metrics {processor,
ttfb_ms}`, `devices {devices}`, `warn {message}`, `error {message}`.

`ready` is sent from `on_pipeline_started`, never before `runner.run`.
Nothing else may write to stdout, so `bot.py` moves fd 1 to stderr at start
and keeps a private duplicate for the protocol (`claim_stdout`).

Spawn env, written by `sidecarEnv` in `voice.ts`: `DEEPGRAM_API_KEY` and
`PHANTOM_CLI_VOICE_*` for voice, mic, speaker, STT model, the two mutes,
headphones, wake, wake words, wake timeout. Operator knobs the app never
sets: `PHANTOM_CLI_VOICE_VAD_STOP`, `_SMART_TURN`, `_LANGUAGE`, `_LOG_LEVEL`.

## How it works

- `Brain` is the LLM slot. `turn` goes out; the app's `speak_*` frames are
  pushed into the pipeline as an LLM's would be. On an interruption pipecat
  stops the audio, Brain sends `interrupted`, and the assistant aggregator,
  placed after the speaker, sends `spoken` with only what was played.
- TTS is Deepgram over HTTP, not the websocket, because the websocket
  emits a sentence's text when it is sent, and `spoken` must hold only
  sentences that played.
- The Deepgram connection policy (`CONNECT_TIMEOUT_S` 2 s, one retry with
  fresh DNS, `KEEP_ALIVE_S` 4 s under Deepgram's 5 s idle close, a slow
  answer never cut) is the same one `phantom-backend/telegram/connect.ts`
  runs. Change one, change the other. The pane gets one `warn` after
  `DOWN_AFTER_S` unreachable and one when it is back.
- Two mutes: `mic` drops what is heard (`UserGate`, `AppMuteStrategy`);
  `speaker` marks reply text skip-TTS, so text still streams and records.
  With headphones off the mic counts as muted while the Assistant speaks.
- Echo over speakers: the mute holds `ECHO_TAIL_S` after speech ends, an
  utterance that started inside that window is dropped, and a transcript
  of three or more words that repeats the last reply is dropped
  (`is_echo_of`).
- Wake word is `LiveWakeStrategy`, always in the pipeline and switched by
  `set`; while awake the sidecar pushes `status {awake, awake_secs}` at
  most once a second.
- Turns end on smart-turn (bundled in pipecat 1.4), silence is the
  fallback (`make_turn_stop`). `ready.turn` says which.
- pipecat is pinned at 1.4.0; every minor renames something. Bump on
  purpose, with the tests and a live `hear` run.
