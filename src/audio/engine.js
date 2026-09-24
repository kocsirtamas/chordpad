import { frequency } from '../theory.js';
import { createAnalogVoice } from './voices/analog.js';
import { createFmVoice } from './voices/fm.js';
import { instrumentFor } from './instruments.js';
import { createSampleVoice } from './voices/sample.js';
import { createSampleLibrary } from './samples.js';
import { createVocoder } from './vocoder.js';
import { WORKLET as GRAIN_WORKLET } from './grain-dsp.js';
import { createSaturator } from './saturator.js';
import { createEffects } from './effects.js';
import { createDrumVoice } from './drums.js';
import { envelopeFor } from './envelope.js';

// Owns the AudioContext and the master chain. Modes and UI never touch nodes
// directly; they hand this module note numbers.

// How much audio the browser renders in one go. The default is the smallest it
// can manage, which is right for playing: a key press is heard at once. It is
// also the least forgiving, since every render has to finish inside that same
// small window, and a machine whose renderer has been pushed down the queue
// misses it and crackles. ?buffer=<ms> asks for a larger one, trading the
// latency for the headroom, and is the switch to reach for if a window that is
// not on top still cracks.
export function bufferHint(search = '') {
  try {
    const ms = Number(new URLSearchParams(search).get('buffer'));
    return Number.isFinite(ms) && ms > 0 ? Math.min(200, ms) / 1000 : null;
  } catch {
    return null;
  }
}

function defaultContextFactory() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  const seconds = bufferHint(globalThis.location ? globalThis.location.search : '');
  if (seconds === null) return new Ctor();
  console.info(`chordpad: asking for a ${Math.round(seconds * 1000)} ms audio buffer`);
  return new Ctor({ latencyHint: seconds });
}

// The headroom one chord may use. Voices divide this between them, so a chord
// is the same loudness whatever it is voiced with. Kept well under the limiter
// threshold: ordinary playing must never touch the limiter, or its gain riding
// is heard as crackle on a sustained chord.
const CHORD_LEVEL = 0.4;

// Drums sit on their own bus at their own level. They are transients rather than
// sustained notes, so they need to be louder than a chord to be heard at all,
// and they must not take part in the chord bus's rebalancing, or adding a beat
// would duck the chords underneath it.
const DRUM_LEVEL = 1.15;

// Above anything anyone can hear, which is how a filter is taken out of the way
// rather than given a special case.
const OPEN_FILTER = 20000;

// A looping sample sits under the playing rather than over it.
const SAMPLE_LOOP_LEVEL = 0.5;

// Debug switches, set from the query string, so a suspect part of the chain can
// be taken out and judged by ear on the device that actually has the problem.
// ?nofx=1 removes the effects rack, ?nolimit=1 removes the limiter.
function debugFlags() {
  try {
    const params = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
    return { noFx: params.has('nofx'), noLimit: params.has('nolimit') };
  } catch {
    return { noFx: false, noLimit: false };
  }
}

export function createEngine({
  contextFactory = defaultContextFactory,
  flags = debugFlags(),
  samples = createSampleLibrary(),
} = {}) {
  let ctx = null;
  let bus = null;
  let limiter = null;
  let drumBus = null;
  let sampleBus = null;
  let outputTap = null;
  let samplesVocoded = false;
  // A rack of its own for the recorded samples, built only once something is
  // being kept from them: measured, an idle rack is 22 ms of every four seconds
  // of audio and a working one 136, so one nobody has asked for is not built.
  let sampleEffects = null;
  let samplesSeparate = false;
  // How the recorded loops are played back. Applied to every one of them at
  // once, so they scale together and stay in step with each other: a speed per
  // loop would pull them apart, which is the one thing the locked length is
  // there to prevent.
  let sampleSpeed = 1;
  let sampleTone = 20000;
  // Semitones, which a buffer source cannot do without changing the speed too.
  let samplePitch = 0;
  let sampleTape = false;
  // The worklet that can, once its module has arrived. Until then, and wherever
  // there is no worklet to be had, a buffer source plays the loop and speed
  // carries pitch with it as it always did.
  let grainReady = false;
  let grainLoading = null;

  function loadGrains() {
    const context = ensureContext();
    if (grainReady) return Promise.resolve(true);
    if (grainLoading) return grainLoading;
    if (!context.audioWorklet || typeof context.audioWorklet.addModule !== 'function') {
      return Promise.resolve(false);
    }
    const url = URL.createObjectURL(new Blob([GRAIN_WORKLET], { type: 'text/javascript' }));
    grainLoading = Promise.resolve(context.audioWorklet.addModule(url))
      .then(() => { grainReady = true; return true; })
      .catch(err => { console.warn('chordpad: no grain player', err); return false; })
      .finally(() => URL.revokeObjectURL(url));
    return grainLoading;
  }
  let loopBus = null;
  let effects = null;
  // A second rack, for loop playback only. Without it every effect is shared,
  // so reaching for the reverb while a loop plays rewrites the loop as well.
  let loopEffects = null;
  // Built the first time it is switched on: a vocoder is a hundred odd nodes,
  // and one that nobody has asked for should cost nothing at all.
  let vocoder = null;
  // What the chord bus feeds when the vocoder is out of the way.
  let busOut = null;
  let vocoderOn = false;
  let master = null;
  let volume = 0.85;
  let active = 0;
  let sounding = 0;
  // What is audible right now, by chord id. The looper asks for this when a take
  // begins: a chord that was already being held when the record button was
  // pressed has announced nothing since, and without this it would be missed.
  const soundingSets = new Map();
  // Recorded samples playing on their own, by id.
  const sampleLoops = new Map();
  let nextSetId = 0;
  const listeners = new Set();

  // Everything that makes a sound is announced here, with the exact notes and
  // settings it was made with. The looper listens, so it records what was
  // sounded rather than what was pressed, and needs to know nothing about modes,
  // articulation, or which control caused it.
  function announce(event) {
    for (const fn of listeners) {
      try { fn(event); } catch (err) { console.error(err); }
    }
  }

  function ensureContext() {
    if (!ctx) {
      ctx = contextFactory();
      bus = ctx.createGain();
      bus.gain.value = 1;

      // A ceiling rather than a compressor. A compressor turns everything down
      // when anything is loud, so the level of a note already sounding depends
      // on what else is playing: that is pumping, and it is what made a held
      // note swell as an older one faded. A curve has no memory, so a key
      // always sounds the same, and ordinary playing is below the threshold
      // where the curve is a straight line and does nothing whatsoever.
      limiter = createSaturator(ctx);

      master = ctx.createGain();
      master.gain.value = volume;

      effects = createEffects(ctx);
      loopEffects = createEffects(ctx);

      drumBus = ctx.createGain();
      drumBus.gain.value = 1;
      drumBus.connect(flags.noFx ? bus : effects.input);

      // Recorded samples run on their own path for the same reason the drums
      // do: the vocoder takes the chord bus as its carrier, so a sample loop
      // sitting on that bus stopped being a sample and became something the
      // voice had to open before any of it could be heard. Switching the
      // vocoder on made every loop fall silent until somebody spoke.
      sampleBus = ctx.createGain();
      sampleBus.gain.value = 1;
      sampleBus.connect(flags.noFx ? bus : effects.input);

      // Loop playback has its own path, so it neither ducks live playing nor is
      // ducked by it, and its own effects rack, so what is being played now and
      // what was recorded then can be treated differently.
      loopBus = ctx.createGain();
      loopBus.gain.value = 1;
      loopBus.connect(flags.noFx ? bus : loopEffects.input);

      // Everything that is heard arrives here, before the volume control, so
      // that anything recording the output records the performance rather than
      // how loud it happened to be turned up at the time.
      outputTap = ctx.createGain();
      outputTap.gain.value = 1;
      outputTap.connect(master);

      // bus -> [effects] -> [limiter] -> tap -> master -> destination, with
      // either of the bracketed stages omitted when its flag is set.
      const afterEffects = flags.noFx ? bus : effects.output;
      busOut = flags.noFx ? null : effects.input;
      if (!flags.noFx) bus.connect(effects.input);
      if (flags.noLimit) {
        afterEffects.connect(outputTap);
        if (!flags.noFx) loopEffects.output.connect(outputTap);
      } else {
        afterEffects.connect(limiter.input);
        if (!flags.noFx) loopEffects.output.connect(limiter.input);
        limiter.output.connect(outputTap);
      }
      master.connect(ctx.destination);
      if (flags.noFx || flags.noLimit) {
        console.warn(`chordpad: ${flags.noFx ? 'effects off ' : ''}${flags.noLimit ? 'limiter off' : ''}`);
      }
    }
    return ctx;
  }

  // Android Chrome does not reliably start a context from resume() alone inside
  // a pointerdown. Nudging it with a one frame silent buffer as well is the
  // reliable unlock, and it has to be retried on later gestures because the
  // first attempt can simply not take.
  function unlock() {
    const context = ensureContext();
    if (context.state === 'running') return true;
    if (typeof context.resume === 'function') {
      Promise.resolve(context.resume()).catch(() => {});
    }
    if (typeof context.createBuffer === 'function' && typeof context.createBufferSource === 'function') {
      try {
        const source = context.createBufferSource();
        source.buffer = context.createBuffer(1, 1, context.sampleRate || 48000);
        source.connect(context.destination);
        source.start(0);
      } catch { /* nothing to unlock with */ }
    }
    return context.state === 'running';
  }

  // Nothing here scales a chord by what else is playing. Every chord is the
  // same level, every time, whatever is already sounding: a key sounds the same
  // whenever it is pressed. What keeps the sum in range is the ceiling at the
  // end of the chain, which rounds peaks off without moving anything.


  function stopLoopFor(id) {
    const loop = sampleLoops.get(id);
    if (!loop) return;
    sampleLoops.delete(id);
    const at = ctx ? ctx.currentTime : 0;
    // Faded rather than cut: stopping a loop mid cycle is a click.
    if (typeof loop.level.gain.setTargetAtTime === 'function') {
      loop.level.gain.setTargetAtTime(0, at, 0.02);
    } else {
      loop.level.gain.value = 0;
    }
    if (loop.source) {
      try { loop.source.stop(at + 0.1); } catch { /* already stopped */ }
    } else if (loop.grain) {
      // A worklet runs until it is let go of, so it is faded and then cut.
      setTimeout(() => { try { loop.grain.disconnect(); } catch { /* already gone */ } }, 150);
    }
  }

  function makeVoice(context, preset, params, destination = bus) {
    // A sampled instrument plays its recording when it has one, and its
    // fallback synth voice until then, so choosing a sound is never a wait.
    if (preset.kind === 'sample') {
      const found = samples.bufferFor(preset, params.semitone);
      if (found) {
        return createSampleVoice(context, destination, {
          ...preset, ...params, gain: levelled(preset, params),
          buffer: found.buffer,
          // As recorded: played at the speed it was recorded at, whichever key
          // was pressed, and with the filter out of the way. Anything else is
          // the recording altered, which is not what a sample is for.
          baseSemitone: params.raw ? params.semitone : found.baseSemitone,
          cutoff: params.raw ? OPEN_FILTER : params.cutoff,
          attack: params.raw ? 0.002 : params.attack,
        });
      }
      // Deliberately with the untrimmed gain: the fallback instrument applies
      // its own, or a quiet sample's trim would be used on a loud oscillator.
      return makeVoice(context, instrumentFor(preset.fallback), params, destination);
    }
    const build = preset.kind === 'fm' ? createFmVoice : createAnalogVoice;
    return build(context, destination, { ...preset, ...params, gain: levelled(preset, params) });
  }

  // Instruments are not equally loud at the same gain: a sine and a sawtooth
  // measure the same in RMS and sound nothing alike, and a sample sits well
  // below either. Each carries a measured trim so they all arrive together.
  function levelled(preset, params) {
    return params.gain * (preset.trim === undefined ? 1 : preset.trim);
  }

  // The device's voice count is a polyphony limit set by its silicon. Here the
  // same control is what it sounds like rather than what it costs: a smaller
  // count is a thinner chord, keeping the notes from the bottom up.
  function limitVoices(semitones, voices) {
    const count = Number(voices) || 0;
    return count > 0 && count < semitones.length ? semitones.slice(0, count) : semitones;
  }

  // Stereo spreads the notes of one chord across the image rather than panning
  // the instrument, so a chord opens up without moving.
  function panFor(index, count, stereo) {
    if (!stereo || count < 2) return 0;
    return -0.8 + (1.6 * index) / (count - 1);
  }

  // The settings that shape a voice but do not belong to the instrument: the
  // ADSR slot, the stereo spread, and the shared vibrato LFO.
  function shaping(env, index, count, stereo, viaLoop = false) {
    const rack = viaLoop ? loopEffects : effects;
    return {
      ...(env ? { attack: env.attack, decay: env.decay, sustain: env.sustain } : {}),
      pan: panFor(index, count, stereo),
      // The wobble comes from the rack the voice is going through, or a loop
      // would take its vibrato from whatever is being played live.
      vibrato: rack ? rack.vibrato : null,
    };
  }

  function releaseNow(set, release) {
    const at = ctx.currentTime;
    for (const voice of set.voices) {
      try { voice.stop(at, release); } catch (err) { console.error(err); }
    }
    active = Math.max(0, active - set.voices.length);
    soundingSets.delete(set.id);

    // A released chord is still sounding while it fades. Dropping it from the
    // count straight away pushed the bus back up, so letting go of several at
    // once made their tails swell before they died. It leaves the count when it
    // has actually gone quiet.
    setTimeout(() => {
      sounding = Math.max(0, sounding - 1);
    }, Math.max(0, release * 1000));

    set.pendingRelease = null;
  }

  return {
    ensureContext,
    unlock,
    isRunning() { return Boolean(ctx) && ctx.state === 'running'; },
    context() { return ctx; },
    masterGain() { return master; },
    // Everything that is heard, before the volume control: what to listen to in
    // order to record the performance rather than the volume knob.
    outputTap() { return outputTap; },
    activeVoiceCount() { return active; },
    soundingChords() { return sounding; },
    // The chords being held at this moment, with what it would take to sound
    // them again. Ordered oldest first, the way they were played.
    soundingNow() {
      return [...soundingSets.entries()].map(([id, held]) => ({ id, ...held }));
    },
    setVolume(next) {
      volume = next;
      if (!master) return;
      // A slider fires a stream of events, and assigning .value makes each one
      // an instantaneous step. On a phone that is a burst of clicks; ramping
      // over a few milliseconds is inaudible and costs nothing.
      if (ctx && typeof master.gain.setTargetAtTime === 'function') {
        master.gain.setTargetAtTime(next, ctx.currentTime, 0.01);
      } else {
        master.gain.value = next;
      }
    },
    voiceBus() { return bus; },
    loopBus() { return loopBus; },
    onSound(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    drumBus() { return drumBus; },
    // The filter is the one thing worth changing on a note that is already
    // sounding, rather than rebuilding the voice and retriggering it.
    setCutoff(set, cutoff) {
      if (!ctx || !set) return;
      const at = ctx.currentTime;
      for (const voice of set.voices) {
        const filter = voice.nodes.filter;
        if (!filter) continue;
        filter.frequency.cancelScheduledValues(at);
        filter.frequency.setValueAtTime(filter.frequency.value, at);
        filter.frequency.linearRampToValueAtTime(cutoff, at + 0.03);
      }
    },
    effects() { return effects; },
    loopEffects() { return loopEffects; },
    // Sampled instruments fetch their recordings the first time they are asked
    // for. Nothing waits on this: the fallback voice plays until it resolves.
    loadInstrument(id) {
      const preset = instrumentFor(id);
      if (!preset || preset.kind !== 'sample') return Promise.resolve(true);
      return samples.load(ensureContext(), preset);
    },
    instrumentStatus(id) {
      const preset = instrumentFor(id);
      if (!preset || preset.kind !== 'sample') return 'ready';
      if (samples.isReady(preset)) return 'ready';
      return samples.isLoading(preset) ? 'loading' : 'missing';
    },
    onSamplesReady(fn) { return samples.onReady(fn); },
    // A recorded sample looping on its own, which is what the sampler makes.
    // Through the chord bus, so the effects rack reaches it, and at a level of
    // its own: a loop that runs under everything else should sit under it.
    loadGrainPlayer() { return loadGrains(); },
    grainPlayerReady() { return grainReady; },

    startSampleLoop(id, buffer) {
      const context = ensureContext();
      // Asked for as soon as there is anything to play, rather than when a
      // pitch is first wanted: which player a loop is on is decided when the
      // loop is built, so a player that turns up afterwards is too late for it.
      loadGrains();
      // Asked for on a context that is not running yet, which happens whenever
      // the tab has been away: a source started on a suspended context plays
      // when it resumes, so there is no reason to refuse. Refusing left the
      // switch saying a loop was running while nothing was, and the only way
      // out was to turn it off and on again.
      if (context.state !== 'running') unlock();
      stopLoopFor(id);
      // The grain player when it is there, which can hold the pitch while the
      // speed moves and is exactly the recording when neither does. A buffer
      // source otherwise, where the two are stuck together.
      let source = null;
      let grain = null;
      const ratio = Math.pow(2, samplePitch / 12) * (sampleTape ? sampleSpeed : 1);
      if (grainReady) {
        grain = new AudioWorkletNode(context, 'grain-voice', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: {
            channel: buffer.getChannelData(0).slice(),
            settings: { speed: sampleSpeed, pitch: ratio },
          },
        });
      } else {
        source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.playbackRate.value = sampleSpeed * Math.pow(2, samplePitch / 12);
        source.start(context.currentTime);
      }
      const tone = context.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = sampleTone;
      const level = context.createGain();
      level.gain.value = SAMPLE_LOOP_LEVEL;
      (grain || source).connect(tone);
      tone.connect(level);
      level.connect(sampleBus);
      sampleLoops.set(id, { source, grain, level, tone, buffer });
      return true;
    },

    stopSampleLoop(id) { stopLoopFor(id); },
    // Where the recorded loops go: into the vocoder when it has been told to
    // take them, into a rack of their own when something is being kept from
    // them, and otherwise into the rack the hands use, which is what they have
    // always done.
    routeSampleBus() {
      if (!sampleBus) return;
      sampleBus.disconnect();
      if (samplesVocoded && vocoder) sampleBus.connect(vocoder.carrier);
      else if (samplesSeparate && sampleEffects) sampleBus.connect(sampleEffects.input);
      else sampleBus.connect(busOut || bus);
    },

    applySampleEffects(settings, separate) {
      ensureContext();
      if (separate && !sampleEffects) {
        sampleEffects = createEffects(ctx);
        sampleEffects.output.connect(limiter ? limiter.input : (outputTap || master));
      }
      if (sampleEffects) sampleEffects.apply(separate ? settings : { bpm: settings.bpm });
      if (separate !== samplesSeparate) {
        samplesSeparate = separate;
        this.routeSampleBus();
      }
    },
    sampleEffects() { return sampleEffects; },
    samplesHaveTheirOwnRack() { return samplesSeparate; },

    // How the loops play back, for the ones running and the ones to come.
    applySampleLoops({ speed = 1, tone = 20000, pitch = 0, tape = false } = {}) {
      sampleSpeed = Math.max(0.05, Math.min(8, Number(speed) || 1));
      sampleTone = Math.max(20, Math.min(20000, Number(tone) || 20000));
      samplePitch = Math.max(-24, Math.min(24, Number(pitch) || 0));
      sampleTape = Boolean(tape);
      // What the pitch control asks for on its own, and what the grain player
      // should read at. On tape, speed carries pitch with it: slower is lower,
      // because the head reads the same marks at a different rate. Off, the
      // loop changes length without changing note, which no tape can do and is
      // the reason for the grain player.
      const offset = Math.pow(2, samplePitch / 12);
      const ratio = offset * (sampleTape ? sampleSpeed : 1);
      const at = ctx ? ctx.currentTime : 0;

      // A loop built before the grain player arrived cannot hold a pitch: it is
      // a buffer source, and reading one faster makes it shorter too. Once
      // there is a player and a pitch is actually wanted, those loops are
      // rebuilt on it. They all go at once, so they come back together.
      if (grainReady && samplePitch !== 0) {
        const stranded = [...sampleLoops.entries()].filter(([, loop]) => !loop.grain && loop.buffer);
        for (const [id, loop] of stranded) this.startSampleLoop(id, loop.buffer);
      }

      for (const loop of sampleLoops.values()) {
        // Ramped rather than jumped: a filter that steps is a thump.
        if (typeof loop.tone.frequency.setTargetAtTime === 'function') {
          loop.tone.frequency.setTargetAtTime(sampleTone, at, 0.02);
        } else {
          loop.tone.frequency.value = sampleTone;
        }
        if (loop.grain) {
          loop.grain.port.postMessage({ settings: { speed: sampleSpeed, pitch: ratio } });
        } else if (loop.source) {
          // Nothing here can hold the pitch while the speed moves, so the two
          // travel together the way they do on tape, whether that was asked for
          // or not. Built from the pitch on its own, since the speed is already
          // in the rate a buffer source is read at.
          const together = sampleSpeed * offset;
          if (typeof loop.source.playbackRate.setTargetAtTime === 'function') {
            loop.source.playbackRate.setTargetAtTime(together, at, 0.02);
          } else {
            loop.source.playbackRate.value = together;
          }
        }
      }
    },
    sampleLoopSettings() {
      return { speed: sampleSpeed, tone: sampleTone, pitch: samplePitch, tape: sampleTape };
    },
    sampleLoopIds() { return [...sampleLoops.keys()]; },

    // A sample recorded here rather than fetched: the microphone's.
    putSample(id, buffer, semitone) { samples.put(id, buffer, semitone); },
    forgetSample(id) { samples.forget(id); },
    applyEffects(settings) {
      if (effects) effects.apply(settings);
    },
    // What loop playback is put through. Told separately from the live rack,
    // because a setting may be wanted on one and not the other.
    applyLoopEffects(settings) {
      if (loopEffects) loopEffects.apply(settings);
    },
    playChord(rawSemitones, { instrument, cutoff, spread = 0, adsr = 'off', stereo = false, voices = 8,
      // Where the chord came from, and the theory it was played under. Not used
      // to make a sound: carried so that whoever records it can build it again
      // later, in another key or another scale.
      origin = null, theory = null,
      // A recording played as it was recorded: one copy of it, at its own
      // pitch. A chord of a sample is three pitch shifted copies at once, which
      // is a sound of its own and not the one that was recorded.
      raw = false, loop = false }) {
      const semitones = limitVoices(rawSemitones, raw ? 1 : voices);
      const context = ensureContext();
      const set = { id: (nextSetId += 1), voices: [], ready: null, pendingRelease: null };

      // Reading currentTime while the context is suspended gives zero, and every
      // envelope built from it fires at once when the clock finally starts. So
      // the voices are built when audio is actually available instead, which on
      // a first touch is a few milliseconds later and inaudible as latency.
      const build = () => {
        const time = context.currentTime;
        const preset = instrumentFor(instrument);
        // Spread the level across the notes, otherwise a four note chord is four
        // times as loud as a single note. Master volume is applied once, at the
        // master gain, never here as well.
        // Scaled by what is already sounding, once, before the voices are built.
        const perVoice = CHORD_LEVEL / Math.max(1, semitones.length);
        const env = envelopeFor(adsr);
        set.voices = semitones.map((semi, i) => makeVoice(context, preset, {
          frequency: frequency(semi),
          semitone: semi,
          cutoff,
          gain: perVoice,
          // Strum rolls the notes rather than sounding them together.
          time: time + i * spread,
          raw,
          loop,
          ...shaping(env, i, semitones.length, stereo),
        }));
        // An ADSR slot owns the whole envelope, its release included, so it
        // replaces the instrument's own cap rather than fighting it.
        set.release = env ? env.release : preset.release;
        active += set.voices.length;
        sounding += 1;
        // release goes with it: a chord the looper adopts has to be written down
        // fading the way this one would have.
        soundingSets.set(set.id, {
          notes: semitones,
          release: set.release,
          opts: { instrument, cutoff, spread, adsr, stereo, voices, origin, theory },
        });
        announce({ kind: 'start', id: set.id, notes: semitones,
          opts: { instrument, cutoff, spread, adsr, stereo, voices, origin, theory } });
        // Released while we were waiting: let it sound, then release it, rather
        // than swallowing the note the user actually played.
        if (set.pendingRelease !== null) releaseNow(set, set.pendingRelease);
      };

      if (context.state === 'running') {
        build();
        set.ready = Promise.resolve();
      } else {
        unlock();
        set.ready = Promise.resolve(context.resume ? context.resume() : undefined)
          .then(build)
          .catch(() => {});
      }
      return set;
    },
    // Changing a chord by stopping it and starting another overlaps a fading
    // set with an attacking one, which doubles the level for the length of the
    // release and is heard as a crack. When the note count matches, the existing
    // voices are simply retuned: no retrigger, no overlap.
    retuneChord(set, semitones, seconds = 0.012) {
      if (!ctx || !set || set.voices.length !== semitones.length) return false;
      const at = ctx.currentTime;
      // Retuning changes what is sounding, so what we would tell the looper
      // changes with it.
      const held = soundingSets.get(set.id);
      if (held) soundingSets.set(set.id, { ...held, notes: semitones });
      set.voices.forEach((voice, i) => {
        const osc = voice.nodes.osc;
        osc.frequency.cancelScheduledValues(at);
        osc.frequency.setValueAtTime(osc.frequency.value, at);
        osc.frequency.linearRampToValueAtTime(frequency(semitones[i]), at + seconds);
      });
      return true;
    },
    // A note or chord of a fixed length, scheduled at an exact audio time.
    // Used by the arpeggiator and by repeat, which need sample accurate timing
    // rather than whenever a timer happens to fire.
    strike(rawSemitones, { instrument, cutoff, spread = 0, release = null, viaLoop = false,
      adsr = 'off', stereo = false, voices: voiceCount = 8, level = 1,
      origin = null, theory = null, raw = false, loop = false }, at, duration) {
      const context = ensureContext();
      if (context.state !== 'running') return null;
      const semitones = limitVoices(rawSemitones, raw ? 1 : voiceCount);
      const preset = instrumentFor(instrument);
      const perVoice = (CHORD_LEVEL * level) / Math.max(1, semitones.length);
      const env = envelopeFor(adsr);
      const voices = semitones.map((semi, i) => makeVoice(context, preset, {
        frequency: frequency(semi),
        semitone: semi,
        cutoff,
        gain: perVoice,
        time: at + i * spread,
        raw,
        loop,
        ...shaping(env, i, semitones.length, stereo, viaLoop),
      }, viaLoop ? loopBus : bus));
      // A replayed chord should fade the way a played one does, so the release
      // follows the sustain setting rather than always being clipped short.
      const tail = release === null ? Math.min(0.25, duration * 0.9) : release;
      for (const voice of voices) voice.stop(at + duration, tail);
      // A struck note is a transient rather than a held chord, so it takes no
      // part in the bus rebalancing: counting them made a dense loop pump.
      if (!viaLoop) {
        announce({ kind: 'strike', notes: semitones,
          opts: { instrument, cutoff, spread, release, adsr, stereo, voices: voiceCount, origin, theory },
          duration });
      }
      return { voices };
    },
    // The microphone shapes the chords: they go in as the carrier, it goes in
    // as the modulator, and what comes out is the chords wearing the voice.
    // Built on first use and taken out of the graph when it is switched off,
    // since an idle rack of filters costs the same as a working one.
    applyVocoder({ on = false, samples = false, ...settings } = {}) {
      if (!on && !vocoder) return;
      ensureContext();
      if (on && !vocoder && busOut) {
        vocoder = createVocoder(ctx);
        vocoder.output.connect(busOut);
      }
      if (!vocoder) return;

      vocoder.apply(settings);
      if (on !== vocoderOn) {
        vocoderOn = on;
        if (on) {
          // The chords stop going straight through and go through the voice.
          bus.disconnect(busOut);
          bus.connect(vocoder.carrier);
        } else {
          bus.disconnect(vocoder.carrier);
          bus.connect(busOut);
        }
      }
      // Recorded loops go through it as well, when asked. Off by default,
      // because a loop that only sounds while somebody is speaking is a
      // surprise rather than a feature: on, it is the whole point of having a
      // loop to speak through.
      const wanted = on && samples;
      if (wanted !== samplesVocoded) {
        samplesVocoded = wanted;
        this.routeSampleBus();
      }
    },
    vocoderTakesSamples() { return samplesVocoded; },
    // Where the microphone goes. Null until the vocoder has been switched on
    // once, which is when there is anything to connect it to.
    vocoderInput() { return vocoder ? vocoder.modulator : null; },
    // The bands themselves, for the debug page and the tests that measure what
    // the voice is actually doing to the chords.
    vocoderBands() { return vocoder ? vocoder.bands : null; },
    vocoderNodes() { return vocoder ? vocoder.nodes : null; },
    // The worklet that measures the voice, whose output channels are the band
    // gains: the one place to look at what the vocoder thinks it is hearing.
    vocoderAnalysis() { return vocoder ? vocoder.analysis() : null; },
    vocoderOn() { return vocoderOn; },

    // The metronome. Deliberately not a drum: it goes to the drum bus so it is
    // heard over everything, and it is announced to nobody, or every loop would
    // record the click that was counting it in.
    click(at = null, accent = false) {
      const context = ensureContext();
      if (context.state !== 'running') return null;
      const time = at === null ? context.currentTime : at;
      const osc = context.createOscillator();
      const amp = context.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(accent ? 1600 : 1050, time);
      amp.gain.setValueAtTime(0.0001, time);
      amp.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.002);
      amp.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      osc.connect(amp);
      amp.connect(drumBus);
      osc.start(time);
      osc.stop(time + 0.08);
      return { osc, amp };
    },
    // Drums ring out on their own, so this fires and forgets.
    // The backing beat is a generator rather than a performance: it keeps running
    // on its own, so recording it would play it twice. record: false says so.
    strikeDrum(drum, kit, at = null, { viaLoop = false, record = true, gain = 1 } = {}) {
      const context = ensureContext();
      if (context.state !== 'running') return null;
      const time = at === null ? context.currentTime : at;
      const voice = createDrumVoice(context, viaLoop ? loopBus : drumBus,
        { drum, kit, time, gain: DRUM_LEVEL * gain });
      if (!viaLoop && record) announce({ kind: 'drum', drum, kit });
      return voice;
    },
    stopChord(set, release) {
      if (!ctx || !set) return;
      // The release is announced with the stop: a replayed note has to fade the
      // way the original did, or the loop sounds clipped short.
      announce({ kind: 'stop', id: set.id, release });
      if (set.voices.length === 0) {
        set.pendingRelease = release;
        return;
      }
      releaseNow(set, release);
    },
  };
}
