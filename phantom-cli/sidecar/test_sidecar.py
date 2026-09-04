"""Offline tests for the sidecar: the wire protocol, config, device matching,
the gates' decisions, and Brain — the LLM slot that hands turns to the TUI and
speaks what it answers — inside a real pipecat pipeline. No audio, no network,
no model.

    uv run python -m unittest test_sidecar -v
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import unittest
from unittest import mock

import bot
import protocol


class FakePA:
    def __init__(self, devices):
        self._d = devices

    def get_device_count(self):
        return len(self._d)

    def get_device_info_by_index(self, i):
        name, inp, out = self._d[i]
        return {"name": name, "maxInputChannels": inp, "maxOutputChannels": out}


DEVICES = [("Studio Display Mic", 1, 0), ("MacBook Pro Speakers", 0, 2),
           ("RODECaster Duo", 2, 2), ("Virtual Cable", 2, 2)]


class Protocol(unittest.TestCase):
    def test_parse_line_accepts_only_typed_objects(self):
        self.assertEqual(protocol.parse_line('{"type":"say","text":"hi"}\n'), {"type": "say", "text": "hi"})
        self.assertIsNone(protocol.parse_line(""))
        self.assertIsNone(protocol.parse_line("not json"))
        self.assertIsNone(protocol.parse_line('["type"]'))
        self.assertIsNone(protocol.parse_line('{"text":"no type"}'))

    def test_encode_is_one_line(self):
        s = protocol.encode({"type": "user", "text": "a\nb", "final": True})
        self.assertTrue(s.endswith("\n"))
        self.assertEqual(s.count("\n"), 1)
        self.assertEqual(json.loads(s), {"type": "user", "text": "a\nb", "final": True})

    def test_send_writes_exactly_the_line(self):
        out = io.StringIO()
        ch = protocol.Channel(out=out)
        ch.send({"type": "ready"})
        self.assertEqual(out.getvalue(), '{"type":"ready"}\n')

    def test_reader_dispatches_then_reports_eof(self):
        inp = io.StringIO('{"type":"speak_start","turn":"t1","step":1}\ngarbage\n{"type":"cancel"}\n')
        ch = protocol.Channel(out=io.StringIO(), inp=inp)
        got: list = []

        async def go():
            done = asyncio.get_running_loop().create_future()
            ch.start_reader(got.append, lambda: done.set_result(True))
            await asyncio.wait_for(done, 2)

        asyncio.run(go())
        self.assertEqual([m["type"] for m in got], ["speak_start", "cancel"])


class Config(unittest.TestCase):
    def test_config_from_env(self):
        env = {
            "DEEPGRAM_API_KEY": "d", "PHANTOM_CLI_VOICE_VOICE": "aura-2-orion-en",
            "PHANTOM_CLI_VOICE_MIC": "RODE", "PHANTOM_CLI_VOICE_SPEAKER": "", "PHANTOM_CLI_VOICE_HEADPHONES": "1",
            "PHANTOM_CLI_VOICE_DEEPGRAM": "4.20.80.213",
            "PHANTOM_CLI_VOICE_MIC_MUTED": "1", "PHANTOM_CLI_VOICE_SPEAKER_MUTED": "1",
            "PHANTOM_CLI_VOICE_WAKE": "true", "PHANTOM_CLI_VOICE_WAKE_WORDS": "hey phantom, computer ,",
            "PHANTOM_CLI_VOICE_WAKE_TIMEOUT": "15", "PHANTOM_CLI_VOICE_VAD_STOP": "0.3",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            c = bot.config_from_env()
        self.assertEqual((c.deepgram_key, c.voice, c.mic, c.speaker), ("d", "aura-2-orion-en", "RODE", ""))
        self.assertEqual(c.deepgram_addr, "4.20.80.213", "the saved address comes back at start")
        self.assertTrue(c.headphones and c.wake)
        self.assertTrue(c.mic_muted and c.speaker_muted, "the saved mutes come back at start")
        self.assertEqual(c.wake_words, ["hey phantom", "computer"])
        self.assertAlmostEqual(c.wake_timeout, 15.0)
        self.assertAlmostEqual(c.vad_stop_secs, 0.3)

    def test_config_defaults(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            c = bot.config_from_env()
        self.assertFalse(c.headphones)
        self.assertFalse(c.mic_muted or c.speaker_muted)
        self.assertFalse(hasattr(c, "provider"), "no model, no key: the brain is the TUI's")
        self.assertEqual(c.wake_words, ["computer"])
        self.assertAlmostEqual(c.wake_timeout, 8.0)
        self.assertEqual(c.deepgram_addr, "", "nothing saved: DNS decides")


class Devices(unittest.TestCase):
    def test_list_devices_splits_by_direction(self):
        d = bot.list_devices(FakePA(DEVICES))
        self.assertEqual(d["mics"], ["Studio Display Mic", "RODECaster Duo", "Virtual Cable"])
        self.assertEqual(d["speakers"], ["MacBook Pro Speakers", "RODECaster Duo", "Virtual Cable"])

    def test_device_index_exact_then_contains_then_default(self):
        pa = FakePA(DEVICES)
        self.assertEqual(bot.device_index(pa, "RODECaster Duo", "in"), 2)
        self.assertEqual(bot.device_index(pa, "rodecaster", "out"), 2)
        self.assertIsNone(bot.device_index(pa, "Studio Display Mic", "out"), "a mic is not a speaker")
        self.assertIsNone(bot.device_index(pa, "Unplugged Thing", "in"))
        self.assertIsNone(bot.device_index(pa, "", "in"))


class Gates(unittest.TestCase):
    def test_user_suppressed(self):
        s = bot.State(headphones=False)
        self.assertFalse(s.user_suppressed())
        s.bot_speaking = True
        self.assertTrue(s.user_suppressed(), "over speakers we would hear ourselves")
        s.headphones = True
        self.assertFalse(s.user_suppressed(), "headphones: talk over it")
        s.mic_muted = True
        self.assertTrue(s.user_suppressed())

    def test_mute_strategy_tracks_bot_speech(self):
        from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, TextFrame
        s = bot.State(headphones=False)
        m = bot.AppMuteStrategy(s)

        async def go():
            self.assertFalse(await m.process_frame(TextFrame(text="x")))
            self.assertTrue(await m.process_frame(BotStartedSpeakingFrame()))
            self.assertTrue(await m.process_frame(TextFrame(text="x")))
            self.assertTrue(await m.process_frame(BotStoppedSpeakingFrame()), "the tail: still muted")
            s.bot_stopped_at -= 10
            self.assertFalse(await m.process_frame(TextFrame(text="x")), "tail over: unmuted")

        asyncio.run(go())

    def test_speaker_gate_marks_skip_tts_only_when_muted(self):
        from pipecat.frames.frames import LLMTextFrame, TranscriptionFrame
        from pipecat.processors.frame_processor import FrameDirection
        s = bot.State(headphones=True)
        g = bot.SpeakerGate(s)
        pushed: list = []

        async def fake_push(frame, direction=FrameDirection.DOWNSTREAM):
            pushed.append(frame)

        g.push_frame = fake_push  # type: ignore[method-assign]

        async def go():
            f1 = LLMTextFrame(text="hello")
            await g.process_frame(f1, FrameDirection.DOWNSTREAM)
            self.assertFalse(f1.skip_tts)
            s.speaker_muted = True
            f2 = LLMTextFrame(text="quiet")
            await g.process_frame(f2, FrameDirection.DOWNSTREAM)
            self.assertTrue(f2.skip_tts, "muted: TTS passes it through unspoken")
            f3 = TranscriptionFrame(text="user said", user_id="u", timestamp="t")
            await g.process_frame(f3, FrameDirection.DOWNSTREAM)
            self.assertFalse(f3.skip_tts, "a transcript is not ours to mark")

        asyncio.run(go())
        self.assertEqual(len(pushed), 3)


class Echo(unittest.TestCase):
    """Over speakers the mic hears us. The tail of our audio is transcribed
    AFTER pipecat says we stopped speaking, and came back as a user turn made
    of our own last sentence — the transcript proved it. Two guards."""

    def test_is_echo_of(self):
        reply = "Not much, just standing by. What would you like to work on?"
        self.assertTrue(bot.is_echo_of("Just standing by. What would you like to work on?", reply))
        self.assertTrue(bot.is_echo_of("what would you like to work on", reply))
        self.assertFalse(bot.is_echo_of("yes", reply), "short replies are the user's")
        self.assertFalse(bot.is_echo_of("what sessions are open", reply))
        self.assertFalse(bot.is_echo_of("what would you like to work on", ""), "nothing said yet")

    def test_tail_after_speaking_still_suppresses_over_speakers(self):
        s = bot.State(headphones=False)
        s.on_bot_started()
        self.assertTrue(s.user_suppressed(now=100.0))
        s.on_bot_stopped()
        t0 = s.bot_stopped_at
        self.assertTrue(s.user_suppressed(now=t0 + 0.5), "the tail: our audio is still being transcribed")
        self.assertFalse(s.user_suppressed(now=t0 + bot.ECHO_TAIL_S + 0.1), "then the mic is the user's again")

    def test_an_utterance_that_began_while_we_spoke_is_dropped_whole(self):
        s = bot.State(headphones=False)
        s.on_bot_started()
        s.on_user_started()           # VAD fires on our own voice
        s.on_bot_stopped()
        s.bot_stopped_at -= 10        # well past the tail
        self.assertTrue(s.user_suppressed(), "still that utterance: it was us")
        s.on_user_started()           # a fresh utterance, in silence
        self.assertFalse(s.user_suppressed())

    def test_headphones_never_suppress_for_echo(self):
        s = bot.State(headphones=True)
        s.on_bot_started(); s.on_user_started()
        self.assertFalse(s.user_suppressed(), "headphones: the mic cannot hear us, talk over us")
        s.mic_muted = True
        self.assertTrue(s.user_suppressed(), "but /mic still mutes")

    def test_user_gate_drops_echo_text_and_keeps_the_user(self):
        from pipecat.frames.frames import LLMFullResponseStartFrame, LLMTextFrame, TranscriptionFrame
        from pipecat.processors.frame_processor import FrameDirection
        out = io.StringIO()
        ch = protocol.Channel(out=out)
        s = bot.State(headphones=False)
        s.bot_stopped_at = -1e9
        tap = bot.AssistantTap(ch, s)
        gate = bot.UserGate(ch, s, bot.LiveWakeStrategy(phrases=["computer"], enabled=False))
        pushed: list = []

        async def fake_push(frame, direction=FrameDirection.DOWNSTREAM):
            pushed.append(frame)

        tap.push_frame = fake_push  # type: ignore[method-assign]
        gate.push_frame = fake_push  # type: ignore[method-assign]

        async def go():
            d = FrameDirection.DOWNSTREAM
            await tap.process_frame(LLMFullResponseStartFrame(), d)
            await tap.process_frame(LLMTextFrame(text="Not much, just standing by. "), d)
            await tap.process_frame(LLMTextFrame(text="What would you like to work on?"), d)
            pushed.clear()
            await gate.process_frame(TranscriptionFrame(text="What would you like to work on?", user_id="u", timestamp="t"), d)
            await gate.process_frame(TranscriptionFrame(text="Show me the open sessions", user_id="u", timestamp="t"), d)

        asyncio.run(go())
        texts = [f.text for f in pushed]
        self.assertEqual(texts, ["Show me the open sessions"])
        self.assertNotIn("What would you like", out.getvalue().split('"assistant_delta"')[-1].split('"user"')[-1] if '"user"' in out.getvalue() else "")

    def test_user_gate_reports_nothing_while_the_wake_gate_is_closed(self):
        from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
        from pipecat.processors.frame_processor import FrameDirection
        out = io.StringIO()
        ch = protocol.Channel(out=out)
        s = bot.State(headphones=True)
        w = bot.LiveWakeStrategy(phrases=["computer"], enabled=True)
        gate = bot.UserGate(ch, s, w)
        pushed: list = []

        async def fake_push(frame, direction=FrameDirection.DOWNSTREAM):
            pushed.append(frame)

        gate.push_frame = fake_push  # type: ignore[method-assign]

        async def go():
            d = FrameDirection.DOWNSTREAM
            # Gated (IDLE): speech reaches the pipeline but never the pane.
            await gate.process_frame(InterimTranscriptionFrame(text="what is", user_id="u", timestamp="t"), d)
            await gate.process_frame(TranscriptionFrame(text="what is open", user_id="u", timestamp="t"), d)
            self.assertNotIn('"user"', out.getvalue(), "asleep: nothing painted")
            # Awake: the same speech paints.
            w._state = bot._WakeState.AWAKE
            await gate.process_frame(TranscriptionFrame(text="show me the sessions", user_id="u", timestamp="t"), d)
            self.assertIn('"user"', out.getvalue())
            self.assertIn("show me the sessions", out.getvalue())
            # Gate off entirely: pass-through, everything paints.
            w.set_enabled(False)
            w._state = bot._WakeState.IDLE
            await gate.process_frame(TranscriptionFrame(text="and the board", user_id="u", timestamp="t"), d)
            self.assertIn("and the board", out.getvalue())

        asyncio.run(go())
        self.assertEqual(len(pushed), 4, "the frames themselves always flow on — only the report is gated")


class LiveWake(unittest.TestCase):
    """The wake gate is always in the pipeline; /voice flips it live."""

    def test_off_lets_everything_through_on_gates_until_the_word(self):
        from pipecat.frames.frames import TranscriptionFrame
        from pipecat.turns.types import ProcessFrameResult
        w = bot.LiveWakeStrategy(phrases=["computer"], enabled=False)

        async def go():
            said = TranscriptionFrame(text="what sessions are open", user_id="u", timestamp="t")
            self.assertEqual(await w.process_frame(said), ProcessFrameResult.CONTINUE, "off: pass-through")
            w.set_enabled(True)
            self.assertEqual(w.state.name, "IDLE", "on: gated until the word is said")
            self.assertFalse(any(p.search(said.text) for p in w._patterns), "not addressed")
            woke = TranscriptionFrame(text="hey computer, what is open", user_id="u", timestamp="t")
            # Triggering the turn needs pipecat's task plumbing; the match itself is what we check.
            self.assertTrue(any(p.search(woke.text) for p in w._patterns))
            w.set_phrases(["hey phantom"])
            self.assertFalse(any(p.search(woke.text) for p in w._patterns), "re-worded live")
            self.assertTrue(any(p.search("hey phantom, open it") for p in w._patterns))
            w.set_enabled(False)
            self.assertEqual(await w.process_frame(said), ProcessFrameResult.CONTINUE)

        asyncio.run(go())

    def test_timeout_is_live_and_refresh_reports_only_while_awake(self):
        w = bot.LiveWakeStrategy(phrases=["computer"], enabled=True, timeout=8.0)
        self.assertAlmostEqual(w._timeout, 8.0)
        refreshes = []
        w.on_refresh = lambda: refreshes.append(True)
        w.set_timeout(3.5)
        self.assertAlmostEqual(w._timeout, 3.5, "the window length changes live")
        self.assertEqual(refreshes, [], "IDLE: nothing to count down, nothing reported")
        w._state = bot._WakeState.AWAKE
        w._refresh_timeout()                 # what any activity frame does while awake
        self.assertEqual(refreshes, [True], "awake: the restarted clock is reported")
        w.enabled = False
        w._refresh_timeout()
        self.assertEqual(refreshes, [True], "gate off: the awake window means nothing")
        w.set_timeout(0)
        self.assertAlmostEqual(w._timeout, 3.5, "a non-positive window is refused")


class HeadphonesLive(unittest.TestCase):
    """`set headphones` flips State (read live everywhere) AND the VAD start
    strategy's private _enable_interruptions. That flag is read each time a
    turn start triggers, not at pipeline build — pinned here so a pipecat bump
    that renames it or bakes it in fails this test, not a live session."""

    def test_vad_interruptions_are_read_per_trigger(self):
        import inspect

        from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy
        from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy

        v = VADUserTurnStartStrategy(enable_interruptions=False)
        self.assertFalse(v._enable_interruptions)
        v._enable_interruptions = True   # what the `set headphones` handler does
        src = inspect.getsource(BaseUserTurnStartStrategy.trigger_user_turn_started)
        self.assertIn("_enable_interruptions", src, "read per trigger — the live flip depends on it")


class TurnEnd(unittest.TestCase):
    def test_smart_turn_is_the_default_and_shortens_the_silence_wait(self):
        from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import TurnAnalyzerUserTurnStopStrategy
        stop, vad_stop, label = bot.make_turn_stop(bot.Config(smart_turn=True, vad_stop_secs=0.4))
        self.assertEqual(label, "smart-turn-v3")
        self.assertEqual(vad_stop, 0.2)
        self.assertIsInstance(stop[0], TurnAnalyzerUserTurnStopStrategy)

    def test_silence_only_when_switched_off(self):
        from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
        stop, vad_stop, label = bot.make_turn_stop(bot.Config(smart_turn=False, vad_stop_secs=0.4))
        self.assertEqual(label, "silence")
        self.assertEqual(vad_stop, 0.4)
        self.assertIsInstance(stop[0], SpeechTimeoutUserTurnStopStrategy)

    def test_env_switch(self):
        with mock.patch.dict(os.environ, {"PHANTOM_CLI_VOICE_SMART_TURN": "0"}, clear=False):
            self.assertFalse(bot.config_from_env().smart_turn)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(bot.config_from_env().smart_turn)



class BrainInPipeline(unittest.TestCase):
    """Brain inside a real pipecat pipeline — [user aggregator] → [Brain] →
    [assistant aggregator], no audio — wired exactly as bot.main wires it,
    including the assistant aggregator's events that produce `spoken`."""

    def run_pipeline(self, script):
        """`script(task, brain, hear)` drives the pipeline; returns the lines
        Brain/`spoken` sent to the TUI, decoded, plus pipecat's own context."""
        from datetime import datetime
        from pipecat.frames.frames import TranscriptionFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineParams, PipelineTask
        from pipecat.processors.aggregators.llm_context import LLMContext
        from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
        from pipecat.turns.user_start.transcription_user_turn_start_strategy import TranscriptionUserTurnStartStrategy
        from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
        from pipecat.turns.user_turn_strategies import UserTurnStrategies

        out = io.StringIO()
        ch = protocol.Channel(out=out)
        context = LLMContext(messages=[])
        agg = LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                start=[TranscriptionUserTurnStartStrategy(use_interim=False)],
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.15)])))
        brain = bot.Brain(ch)

        @agg.assistant().event_handler("on_assistant_turn_started")
        async def _started(_a):
            brain.assistant_started()

        @agg.assistant().event_handler("on_assistant_turn_stopped")
        async def _stopped(_a, m):
            ref = brain.assistant_stopped()
            if ref is not None:
                ch.send({"type": "spoken", "turn": ref[0], "step": ref[1], "text": m.content or "", "interrupted": bool(m.interrupted)})

        async def hear(task, text):
            await task.queue_frames([UserStartedSpeakingFrame(),
                TranscriptionFrame(text=text, user_id="u", timestamp=datetime.now().isoformat()),
                UserStoppedSpeakingFrame()])

        async def go():
            pipeline = Pipeline([agg.user(), brain, agg.assistant()])
            task = PipelineTask(pipeline, params=PipelineParams(), cancel_on_idle_timeout=False)
            runner = PipelineRunner(handle_sigint=False)
            run = asyncio.create_task(runner.run(task))
            await asyncio.sleep(0.2)
            await script(task, brain, hear)
            await task.cancel()
            await run

        asyncio.run(go())
        lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
        return lines, context

    def test_a_turn_reaches_the_tui_and_a_reply_is_spoken_in_full(self):
        async def script(task, brain, hear):
            await hear(task, "which sessions are open")
            await asyncio.sleep(0.6)
            await brain.speak_start("t1", 1)
            for d in ["Just ", "one, ", "s1."]:
                await brain.speak_delta("t1", d)
            await brain.speak_end("t1")
            await asyncio.sleep(0.4)

        lines, ctx = self.run_pipeline(script)
        self.assertIn({"type": "turn", "text": "which sessions are open"}, lines)
        self.assertIn({"type": "spoken", "turn": "t1", "step": 1, "text": "Just one, s1.", "interrupted": False}, lines)
        self.assertEqual([m["role"] for m in ctx.get_messages()], ["user", "assistant"])

    def test_interruption_reports_only_what_got_through_and_drops_late_deltas(self):
        async def script(task, brain, hear):
            await brain.speak_start("t2", 1)
            await brain.speak_delta("t2", "There are three sessions, ")
            await brain.speak_delta("t2", "the first ")
            await asyncio.sleep(0.2)
            await brain.interrupt()                         # what `cancel` does
            await asyncio.sleep(0.3)
            await brain.speak_delta("t2", "one is busy.")   # stale: the TUI's abort is racing us
            await brain.speak_end("t2")
            await asyncio.sleep(0.2)
            await hear(task, "no, the second")             # the next turn still arrives
            await asyncio.sleep(0.6)

        lines, ctx = self.run_pipeline(script)
        interrupted = [l for l in lines if l["type"] == "interrupted"]
        # Told once for the cancel (naming the turn being spoken), once more
        # when the next user turn starts — a new turn interrupts by design.
        self.assertEqual(len(interrupted), 2, interrupted)
        self.assertEqual(interrupted[0].get("turn"), "t2")
        spoken = [l for l in lines if l["type"] == "spoken"]
        self.assertEqual(spoken, [{"type": "spoken", "turn": "t2", "step": 1, "text": "There are three sessions, the first", "interrupted": True}])
        self.assertIn({"type": "turn", "text": "no, the second"}, lines)
        self.assertNotIn("one is busy", json.dumps(ctx.get_messages()))

    def test_two_steps_are_matched_in_order(self):
        async def script(task, brain, hear):
            await brain.speak_start("t3", 1)
            await brain.speak_delta("t3", "Let me look.")
            await brain.speak_end("t3")
            await brain.speak_start("t3", 2)
            await brain.speak_delta("t3", "Two are open.")
            await brain.speak_end("t3")
            await asyncio.sleep(0.5)

        lines, _ = self.run_pipeline(script)
        spoken = [(l["step"], l["text"], l["interrupted"]) for l in lines if l["type"] == "spoken"]
        self.assertEqual(spoken, [(1, "Let me look.", False), (2, "Two are open.", False)])


class DeepgramAddressBook(unittest.TestCase):
    """One address book for STT and TTS: whatever site either link reaches,
    both use; a dead connect fails at 2 s and is retried once; the pane hears
    about it once when the link stays down and once when it is back.
    Background: api.deepgram.com rotates between sites and two of them (on
    Cogent) never answer from this network (2026-09-02) — aiohttp's 30 s
    connect default queued every reply behind the hang."""

    def test_session_fails_a_dead_connect_at_two_seconds_and_caps_nothing_else(self):
        async def go():
            s = bot.tts_session(bot.AddressBook(inner=mock.Mock()))
            try:
                self.assertEqual(s.timeout.sock_connect, bot.TTS_CONNECT_S)
                self.assertIsNone(s.timeout.total, "a request that connected is never cut short")
                self.assertFalse(s.connector.use_dns_cache, "the book must be asked every time")
            finally:
                await s.close()
        asyncio.run(go())
        self.assertEqual(bot.TTS_CONNECT_S, 2.0, "normal connect is 18–49 ms, the slow live site ~1 s; 0.5 s dropped that site")

    def test_book_answers_with_the_working_address_else_dns(self):
        class DNS:
            calls = 0
            async def resolve(self, host, port=0, family=0):
                self.calls += 1
                return [{"hostname": host, "host": "216.200.21.203", "port": port, "family": 2, "proto": 0, "flags": 0}]
            async def close(self): pass

        dns = DNS()
        book = bot.AddressBook(inner=dns)
        told: list[str] = []
        book.on_change = told.append
        self.assertEqual(asyncio.run(book.resolve("api.deepgram.com", 443))[0]["host"], "216.200.21.203")
        self.assertEqual(dns.calls, 1)
        book.worked("api.deepgram.com", "4.20.80.213")
        self.assertEqual(asyncio.run(book.resolve("api.deepgram.com", 443))[0]["host"], "4.20.80.213")
        self.assertEqual(dns.calls, 1, "a working address is reused without asking DNS")
        self.assertEqual(book.failed("api.deepgram.com"), "4.20.80.213")
        asyncio.run(book.resolve("api.deepgram.com", 443))
        self.assertEqual(dns.calls, 2, "after a failure DNS is asked again")
        self.assertEqual(told, ["4.20.80.213", ""], "the app hears the address found and the address dropped")

    def test_the_event_loop_resolves_through_the_book_too(self):
        """STT's websocket resolves through asyncio, not aiohttp — the book
        hooks the loop so STT follows a site TTS found (and vice versa)."""
        async def go():
            loop = asyncio.get_running_loop()
            book = bot.AddressBook(inner=mock.Mock())
            book.install(loop)
            book.worked("api.deepgram.com", "4.20.80.213")
            infos = await loop.getaddrinfo("api.deepgram.com", 443)
            self.assertEqual(infos[0][4], ("4.20.80.213", 443))
            infos = await loop.getaddrinfo("localhost", 80)          # anything else: real DNS
            self.assertIn(infos[0][4][0], ("127.0.0.1", "::1"))
        asyncio.run(go())

    def test_a_fresh_connect_records_the_address_it_reached(self):
        from aiohttp import web

        async def go():
            app = web.Application()
            app.router.add_get("/", lambda _r: web.Response(text="ok"))
            runner = web.AppRunner(app); await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0); await site.start()
            port = site._server.sockets[0].getsockname()[1]
            book = bot.AddressBook()
            import aiohttp
            async with aiohttp.ClientSession(connector=bot.sticky_connector(book)) as s:
                async with s.get(f"http://localhost:{port}/") as r:
                    self.assertEqual(r.status, 200)
                self.assertEqual(book.good, {"localhost": "127.0.0.1"})
            await runner.cleanup()
        asyncio.run(go())

    def _req(self):
        req = mock.Mock(); req.url.host = "api.deepgram.com"
        return req

    def test_a_dead_connect_drops_the_address_retries_once_and_marks_tts(self):
        import aiohttp
        book = bot.AddressBook(inner=mock.Mock())
        book.worked("api.deepgram.com", "38.68.64.132")      # DNS gave the dead site last time
        mw = bot.tts_retry_middleware(book)
        calls: list[int] = []

        async def handler(_req):
            calls.append(1)
            if len(calls) == 1:
                raise aiohttp.ConnectionTimeoutError("Connection timeout to host")
            return "audio"

        self.assertEqual(asyncio.run(mw(self._req(), handler)), "audio")
        self.assertEqual(len(calls), 2)
        self.assertEqual(book.good, {}, "the dead address is forgotten; the retry asked DNS")
        self.assertTrue(book.tts_ok)

        async def always_down(_req):
            calls.append(1)
            raise aiohttp.ClientConnectorError(mock.Mock(host="h", port=443, ssl=None), OSError("down"))
        with self.assertRaises(aiohttp.ClientConnectorError):
            asyncio.run(mw(self._req(), always_down))
        self.assertEqual(len(calls), 4, "one retry, then the error stands")
        self.assertFalse(book.tts_ok, "the health line knows TTS cannot reach Deepgram")

        async def slow(_req):
            calls.append(1)
            raise TimeoutError("read")            # not a connect failure
        with self.assertRaises(TimeoutError):
            asyncio.run(mw(self._req(), slow))
        self.assertEqual(len(calls), 5, "a slow response is not retried")

    def test_health_speaks_once_when_down_once_when_back_and_shares_stt_address(self):
        out = io.StringIO()
        ch = protocol.Channel(out=out)

        class FakeWS:
            remote_address = ("4.20.80.213", 443)
        class FakeConn:
            _websocket = FakeWS()
        class FakeSTT:
            def __init__(self):
                self._connection_ready = asyncio.Event()
                self._connection = FakeConn()

        async def go():
            stt = FakeSTT(); stt._connection_ready.set()
            book = bot.AddressBook(inner=mock.Mock())
            task = asyncio.create_task(bot.health(stt, book, ch, down_after=0.3, tick=0.05))
            await asyncio.sleep(0.15)
            self.assertEqual(book.good, {"api.deepgram.com": "4.20.80.213"}, "TTS follows the site STT reached")
            stt._connection_ready.clear(); await asyncio.sleep(0.15); stt._connection_ready.set()   # a blip
            await asyncio.sleep(0.2)
            self.assertEqual(out.getvalue(), "", "a reconnect within the window is nobody's business")
            book.tts_ok = False; await asyncio.sleep(0.5)                                            # TTS down, STT still up
            self.assertIn("can't reach Deepgram", out.getvalue())
            self.assertEqual(out.getvalue().count("\n"), 1, "one line, however long it stays down")
            self.assertEqual(book.good, {"api.deepgram.com": "4.20.80.213"}, "STT is up on that address, so it stays")
            await asyncio.sleep(0.4)
            self.assertEqual(out.getvalue().count("\n"), 1)
            book.tts_ok = True; await asyncio.sleep(0.15)
            self.assertIn("back", out.getvalue())
            self.assertEqual(out.getvalue().count("\n"), 2)
            stt._connection_ready.clear(); book.tts_ok = False; await asyncio.sleep(0.5)                 # both down
            self.assertEqual(out.getvalue().count("\n"), 3)
            self.assertEqual(book.good, {}, "nothing reaches that address any more: dropped, the next attempt asks DNS")
            stt._connection_ready.set(); book.tts_ok = True; await asyncio.sleep(0.15)
            self.assertEqual(out.getvalue().count("\n"), 4)
            self.assertEqual(book.good, {"api.deepgram.com": "4.20.80.213"}, "back, and STT's address is recorded again")
            task.cancel()
        asyncio.run(go())

    def test_the_fields_health_reads_still_exist_in_the_installed_libraries(self):
        from pipecat.services.deepgram.stt import DeepgramSTTService
        from deepgram.listen.v1.socket_client import AsyncV1SocketClient
        from websockets.legacy.client import WebSocketClientProtocol
        stt = DeepgramSTTService(api_key="x")
        self.assertTrue(isinstance(stt._connection_ready, asyncio.Event), "pipecat moved the STT connection state — fix health()")
        self.assertTrue(hasattr(stt, "_connection"), "pipecat renamed the SDK client field — fix stt_peer()")
        self.assertIn("_websocket", vars(AsyncV1SocketClient(websocket=mock.Mock())), "the Deepgram SDK moved its websocket — fix stt_peer()")
        self.assertTrue(hasattr(WebSocketClientProtocol, "remote_address"))
