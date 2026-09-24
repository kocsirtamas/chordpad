// The microphone: asking for it, holding it, and handing it out.
//
// One place does this because three features want the same stream, and because
// the interesting part is not the audio but the refusals. getUserMedia exists
// only in a secure context, so over the plain HTTP address there is no
// microphone to ask for at all and saying so plainly is the whole job.

import { detectPitch, nearestNote } from './pitch.js';

export const MIC_STATES = ['unavailable', 'idle', 'asking', 'live', 'denied'];

// How much sound to look at when working out a pitch. Two thousand odd samples
// is a twentieth of a second: long enough to hold two periods of the lowest
// note worth tuning, short enough to answer while the note is still being held.
const WINDOW = 4096;

export function createMic({ engine, media = globalThis.navigator ? globalThis.navigator.mediaDevices : null } = {}) {
  let state = supported() ? 'idle' : 'unavailable';
  let stream = null;
  let source = null;
  let analyser = null;
  let silence = null;
  const listeners = new Set();

  function supported() {
    return Boolean(media && typeof media.getUserMedia === 'function');
  }

  function announce() {
    for (const fn of listeners) {
      try { fn(state); } catch (err) { console.error(err); }
    }
  }

  function set(next) {
    if (state === next) return;
    state = next;
    announce();
  }

  return {
    state() { return state; },
    isLive() { return state === 'live'; },
    // Why it cannot be used, in the words the interface should show.
    reason() {
      if (state === 'unavailable') {
        return 'no microphone here: open the https address';
      }
      return state === 'denied' ? 'microphone refused by the browser' : '';
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async enable() {
      if (state === 'live') return true;
      if (!supported()) {
        set('unavailable');
        return false;
      }
      set('asking');
      try {
        // No processing: echo cancellation and noise suppression are built for
        // speech and would fight both the tuner and the vocoder.
        stream = await media.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch (err) {
        console.warn('chordpad: no microphone', err);
        set('denied');
        return false;
      }

      const ctx = engine.ensureContext();
      engine.unlock();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = WINDOW;
      source.connect(analyser);

      // An analyser is only handed samples while it is part of a path that
      // reaches the output, and the one thing the microphone must not do is
      // reach the output: that is how a room starts howling. A gain of zero is
      // both, so it is pulled every quantum and heard by nobody.
      silence = ctx.createGain();
      silence.gain.value = 0;
      analyser.connect(silence);
      silence.connect(ctx.destination);
      set('live');
      return true;
    },

    disable() {
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (source) source.disconnect();
      if (analyser) analyser.disconnect();
      if (silence) silence.disconnect();
      stream = null;
      source = null;
      analyser = null;
      silence = null;
      set(supported() ? 'idle' : 'unavailable');
    },

    // The node to feed anything that wants to listen: the vocoder's modulator,
    // or the sampler's tap.
    source() { return source; },
    analyser() { return analyser; },

    // What is being sung or played right now, or null. Cheap enough to ask
    // several times a second, which is what a tuner does.
    hear() {
      if (!analyser || typeof analyser.getFloatTimeDomainData !== 'function') return null;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const ctx = engine.context();
      const hz = detectPitch(samples, ctx ? ctx.sampleRate : 48000);
      return hz === null ? null : nearestNote(hz);
    },
  };
}
