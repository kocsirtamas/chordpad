// The sampler: hold to record, let go and it loops.
//
// A sample here is not an instrument to be selected and played from the keys,
// it is a loop that runs on its own and is switched off when it has outstayed
// its welcome. Holding the button is the length: half a second of it is a half
// second loop, four seconds of it is four.
//
// Taken as raw samples off the audio thread rather than through an encoder: a
// recording that is going to be looped for an hour should not start out lossy.
// A microphone needs a secure context and so does an AudioWorklet, so wherever
// one is available the other is too.
//
// What it listens to is either the microphone or the instrument's own output.
// The second is resampling: play something, record what comes out of it, and
// the recording becomes a layer to play over. Everything that shapes the sound
// is already in it by then, the vocoder included, which is the one thing
// recording the microphone can never capture.

import { TAP_WORKLET } from './recorder.js';
import { detectPitch, nearestNote, semitoneOf } from './pitch.js';

// A ceiling rather than a length: nobody means to hold the button for a minute,
// and a runaway recording is megabytes a second.
export const MAX_SECONDS = 30;

// Where a sample with no pitch of its own is played from when it is played
// chromatically: middle C, so it sounds as recorded on the key it was made for.
const UNPITCHED = 60;

// Every recording is brought to the same peak, so that what was captured
// quietly plays back next to what was captured loudly. It matters most when
// recording the output: a vocoded chord is a fraction of the level of a loop
// that is already running, so measured, the second recording came back six
// times louder than the first and drowned it, and by the fourth every peak was
// against the ceiling. The bounds stop a whisper being amplified into its own
// room noise, and stop something already loud being pushed further.
const TARGET_PEAK = 0.7;
const QUIETEST = 0.25;
const LOUDEST = 16;

function normalise(data) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const level = data[i] < 0 ? -data[i] : data[i];
    if (level > peak) peak = level;
  }
  if (peak < 1e-4) return 1;
  const gain = Math.min(LOUDEST, Math.max(QUIETEST, TARGET_PEAK / peak));
  if (gain === 1) return 1;
  for (let i = 0; i < data.length; i++) data[i] *= gain;
  return gain;
}

// Sixteen sixteenths, which is what the transport counts a bar as.
const STEPS_PER_BAR = 16;

export function createSampler({ engine, mic, clock = null }) {
  let recording = null;
  let samples = [];
  let counter = 0;
  // The length the first recording set, in samples. Everything after it is cut
  // or padded to exactly that, so two loops recorded by hand stay together
  // instead of drifting apart a little more on every pass. Nobody can hold a
  // button for the same length twice, and a loop that is a twentieth of a
  // second long than another has walked a whole beat away inside a minute.
  let locked = null;
  // What the start now on its way asked for, so that letting go of the button
  // knows whether it is being listened to.
  let pendingBars = 0;
  // Starting has to wait for the microphone and for the worklet to load, and a
  // finger can easily be lifted before either arrives. Letting go then found no
  // recording to stop and did nothing, and the recording that turned up a
  // moment later ran until the ceiling: thirty seconds of whatever the room was
  // doing, with the button stuck on. So a start in flight is counted, and
  // letting go cancels the one that has not arrived yet.
  let starting = 0;
  let cancelled = 0;
  const listeners = new Set();

  function phase() {
    return recording !== null || starting > cancelled ? 'recording' : 'idle';
  }

  function announce() {
    const busy = recording !== null || starting > cancelled;
    const now = phase();
    for (const fn of listeners) {
      try { fn(busy, samples, now); } catch (err) { console.error(err); }
    }
  }

  return {
    isRecording() { return recording !== null || starting > cancelled; },
    phase,
    // What every recording after the first is held to, in seconds, or null
    // while there is nothing to stay together with.
    lockedSeconds() {
      if (locked === null) return null;
      const ctx = engine.context();
      return locked / ((ctx && ctx.sampleRate) || 48000);
    },
    samples() { return samples.map(s => ({ ...s })); },
    // The most recent one, which is what the keys play when the mic instrument
    // is chosen.
    latest() { return samples.length ? samples[samples.length - 1] : null; },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Held down: recording runs until stop, or until the ceiling. From the
    // microphone by default, or from the output, which needs no microphone at
    // all and so no permission either.
    //
    // With bars asked for, how long the button is held stops mattering: the
    // take begins on the next downbeat and runs for exactly that many bars, so
    // what comes out lines up with the drums and the arpeggiator rather than
    // only with the other samples. The recording runs from the moment of the
    // press either way and is cut to the bar afterwards, which is accurate to
    // the sample rather than to whenever a timer happened to fire.
    async start({ from = 'mic', bars = 0 } = {}) {
      if (recording || starting > cancelled) return false;
      const mine = starting + 1;
      starting = mine;
      pendingBars = bars;
      // Anything that waits is checked against this afterwards: if the button
      // was let go of in the meantime, nothing is left running.
      const abandoned = () => cancelled >= mine;
      const giveUp = () => {
        if (starting === mine) { starting = 0; cancelled = 0; pendingBars = 0; }
        announce();
        return false;
      };

      const listening = from === 'out';
      if (!listening && !mic.isLive() && !(await mic.enable())) return giveUp();
      if (abandoned()) return giveUp();

      const ctx = engine.ensureContext();
      const source = listening ? engine.outputTap() : mic.source();
      if (!ctx || !source || !ctx.audioWorklet) return giveUp();

      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (abandoned()) return giveUp();

      const chunks = [];
      const tap = new AudioWorkletNode(ctx, 'session-tap');
      tap.port.onmessage = event => chunks.push(event.data);
      source.connect(tap);

      // The tap has to be pulled by something to run at all, and the one place
      // it must not be heard is the output: a microphone played back into the
      // room is feedback. A gain of zero is pulled and silent.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      tap.connect(sink);
      sink.connect(ctx.destination);

      recording = { ctx, source, tap, sink, chunks, from, startedAt: ctx.currentTime,
        bars: 0, wanted: 0 };
      starting = 0;
      cancelled = 0;
      pendingBars = 0;

      if (bars > 0 && clock) {
        // A bar is only a length while something is counting them.
        if (!clock.isRunning()) clock.start();
        const barSeconds = clock.stepDuration() * STEPS_PER_BAR;
        recording.bars = bars;
        // Recorded from the press, for exactly one take's worth. Waiting for a
        // beat to come round before starting was the obvious thing and it was
        // wrong: the wait is up to a second for two quarters and up to eight
        // for four bars, and everything said inside it is in front of the take
        // and thrown away. Which is what happens to anybody who presses the
        // button and starts, which is everybody.
        //
        // Nothing has to be thrown away, because a loop is a circle. A take
        // exactly one length long repeats with that period wherever it began,
        // so every sound in it comes back at the same distance from the beat it
        // was played at, for ever. The length is what has to land on the grid,
        // not the moment the button was pressed.
        recording.wanted = Math.round(bars * barSeconds * ctx.sampleRate);
      }
      // However long the button is held, within reason, or exactly as long as
      // the first one if there is a first one: stopping on time is what makes
      // the loop start on time, rather than being trimmed after the fact.
      // Long enough to be sure the samples have arrived, since what is kept is
      // counted rather than timed: a timer that fires a little late costs
      // nothing and one that fires early would cut the take short.
      const room = recording.wanted || locked;
      const limit = room
        ? Math.max(50, (room / ctx.sampleRate) * 1000 + 120)
        : MAX_SECONDS * 1000;
      recording.ceiling = setTimeout(() => { if (recording) this.stop({ byHand: false }); }, limit);
      announce();
      return true;
    },

    // Let go: the recording becomes a loop and starts playing at once.
    //
    // Unless a number of bars was asked for, in which case letting go is not
    // what ends it. The take runs from the downbeat for exactly that long and
    // stops itself, which is the whole point: a bar is a length the transport
    // decides, not a length a finger decides.
    stop({ byHand = true } = {}) {
      if (byHand && (recording ? recording.bars > 0 : pendingBars > 0)) return null;
      // Let go before it ever got going: cancel the one that is on its way, so
      // it does not start recording into an empty room after the fact.
      if (!recording) {
        if (starting > cancelled) {
          cancelled = starting;
          announce();
        }
        return null;
      }
      const { ctx, source, tap, sink, chunks } = recording;
      const take = recording;
      clearTimeout(recording.ceiling);
      tap.port.onmessage = null;
      source.disconnect(tap);
      tap.disconnect();
      sink.disconnect();
      recording = null;

      let length = 0;
      for (const chunk of chunks) length += chunk.length;
      // A tap that never ran, or a button pressed and released in one frame.
      if (length < 256) {
        announce();
        return null;
      }

      // Everything that was heard, laid out end to end, before anything is
      // decided about where the take begins and ends.
      const heard = new Float32Array(length);
      let wrote = 0;
      for (const chunk of chunks) {
        heard.set(chunk, wrote);
        wrote += chunk.length;
      }

      const wanted = take.wanted > 0 ? take.wanted : null;

      // Held to whatever the first one was: short is padded with silence, long
      // is cut. The alternative is loops that are nearly the same length, which
      // sounds like one of them slowing down.
      const size = locked !== null ? locked : (wanted !== null ? wanted : length);
      if (size < 1) {
        announce();
        return null;
      }
      const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      const keep = Math.min(size, length);
      if (keep > 0) data.set(heard.subarray(0, keep), 0);
      if (locked === null) locked = size;

      // Pitched from the middle rather than the start, where a voice is still
      // arriving and a string is still being plucked. Asked before the level is
      // brought up, since whether something was quiet enough to be nothing is a
      // question about what the microphone heard, not about what was done to it
      // afterwards.
      const from = Math.floor(size * 0.25);
      const hz = detectPitch(data.subarray(from, from + Math.min(8192, size - from)), ctx.sampleRate);
      normalise(data);
      const note = hz === null ? null : nearestNote(hz);
      counter += 1;
      const sample = {
        id: `s${counter}`,
        buffer,
        seconds: size / ctx.sampleRate,
        semitone: hz === null ? UNPITCHED : Math.round(semitoneOf(hz)),
        pitched: hz !== null,
        note,
        // On the moment it exists: letting go of the button is the cue to hear
        // it, not the cue to go and find a switch for it.
        playing: true,
      };
      samples = [...samples, sample];
      // Whether it is actually looping, not whether it was asked to. A switch
      // that says a loop is running while nothing is running is why the fix was
      // to turn it off and on again.
      sample.playing = engine.startSampleLoop(sample.id, sample.buffer) !== false;
      announce();
      return sample;
    },

    // Stops or starts one loop. What a sample is for is being switched in and
    // out while something else is playing.
    toggle(id) {
      const sample = samples.find(s => s.id === id);
      if (!sample) return;
      const wanted = !sample.playing;
      if (wanted) sample.playing = engine.startSampleLoop(sample.id, sample.buffer) !== false;
      else {
        engine.stopSampleLoop(sample.id);
        sample.playing = false;
      }
      announce();
    },

    remove(id) {
      engine.stopSampleLoop(id);
      samples = samples.filter(s => s.id !== id);
      // Nothing left to stay together with, so the next one sets the length.
      if (samples.length === 0) locked = null;
      announce();
    },

    clear() {
      for (const sample of samples) engine.stopSampleLoop(sample.id);
      samples = [];
      locked = null;
      announce();
    },
  };
}
