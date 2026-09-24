// One store, one shape. UI reads from here and subscribes. Nothing keeps a
// private copy of anything that lives in state.

import { PERSISTED_KEYS } from './presets.js';
import { VOCODER_DEFAULTS } from './audio/vocoder.js';

// Loading a preset marks it as the one in force. Changing anything it set means
// what is loaded is no longer that preset, so the mark is dropped in the same
// update. Doing this here rather than in a subscriber matters: a subscriber that
// sets state re-enters this function, and the outer notification then overwrites
// the newer value with the one it started from.
function forgetPresetOnEdit(current, patch, next) {
  if (patch.activePreset !== undefined || next.activePreset === null) return next;
  const edited = PERSISTED_KEYS.some(key => key in patch && patch[key] !== current[key]);
  return edited ? { ...next, activePreset: null } : next;
}

export function createStore(initial) {
  let current = { ...initial };
  const listeners = new Set();
  let notifying = false;
  let changedWhileNotifying = false;

  return {
    get() {
      return current;
    },
    set(patch) {
      current = forgetPresetOnEdit(current, patch, { ...current, ...patch });

      // A listener may set state of its own: releasing a chord in response to a
      // setting change, say. Without this the outer notification would finish
      // afterwards and hand subscribers the state it started with, quietly
      // undoing the newer one. Instead the nested change is noted and everyone
      // is told again with the latest.
      if (notifying) {
        changedWhileNotifying = true;
        return current;
      }

      notifying = true;
      try {
        do {
          changedWhileNotifying = false;
          const snapshot = current;
          for (const fn of listeners) {
            // A broken listener must not take the rest of the UI down with it.
            try { fn(snapshot); } catch (err) { console.error(err); }
          }
        } while (changedWhileNotifying);
      } finally {
        notifying = false;
      }
      return current;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const INITIAL_STATE = {
  keyRoot: 0,
  scale: 'major',
  mode: 'play',
  bpm: 120,
  arpPattern: 'up',
  arpRate: '1/16',
  arpChord: 'arp',
  reverb: false,
  // How wet the reverb is when it is on. The one effect worth a dial: how much
  // room a sound wants depends entirely on the sound.
  reverbMix: 0.35,
  // How long the room rings for, in seconds. The mix is how much of it is
  // heard; this is how big it is.
  reverbTime: 2.25,
  chorus: false,
  flanger: false,
  stereo: false,
  delay: 'off',
  tremolo: 'off',
  vibrato: 'off',
  glide: 'off',
  voices: 8,
  adsr: 'off',
  inversion: 0,
  voiceLeading: false,
  bass: 'off',
  kit: 'tight',
  beat: 'off',
  beatVariation: 'original',
  autoDrum: 'off',
  looper: { mode: 'off', tracks: 0, length: 0, mix: [] },
  // Which settings reach a loop that is already recorded. Off means the loop
  // keeps what it was recorded with. See loopfx.js for the categories.
  // Whether a key, a sound or a mode lands now or on the next downbeat.
  // Whether the transport runs: on what needs it, or switched on or off by hand.
  transport: 'auto',
  onTheBeat: false,
  // What is waiting for one, so it can be seen rather than guessed at.
  pending: {},
  toLoop: {},
  // Which effects reach the recorded samples. Absent means yes, which is what
  // they got when they shared a rack with the hands.
  toSample: {},
  // How many samples exist, so the switches can say when they have nothing to
  // reach. Kept here rather than asked for, since the panels only read state.
  sampleCount: 0,
  // The microphone features. mic is what the browser has told us; the rest are
  // settings that outlive a permission prompt.
  mic: 'idle',
  tuner: false,
  tunerNote: null,
  sampler: 'empty',
  samplerNote: null,
  // As recorded: one copy at its own pitch, filter out of the way. Off means
  // the recording is played like any other instrument, pitched by the keys.
  // What the sampler listens to: the microphone, or the instrument's own
  // output, which is resampling.
  samplerSource: 'mic',
  // How long a take is: zero for as long as the button is held, or that many
  // bars of the transport, beginning on the next downbeat.
  samplerBars: 0,
  // How the recorded loops play back: speed carries pitch with it, as tape does.
  sampleSpeed: 1,
  // Semitones, held while the speed moves, which needs the grain player.
  samplePitch: 0,
  // Whether the speed carries the pitch with it, the way tape does.
  sampleTape: false,
  sampleTone: 20000,
  samplerRaw: true,
  samplerLoop: false,
  vocoder: false,
  // One source: the vocoder decides what its own defaults are, since two of
  // them follow from how the bands are spaced rather than from taste.
  // Whether recorded loops go through the vocoder as well as the chords.
  vocoderSamples: false,
  vocoderFormant: VOCODER_DEFAULTS.formant,
  vocoderQ: VOCODER_DEFAULTS.q,
  vocoderAttack: VOCODER_DEFAULTS.attack,
  vocoderRelease: VOCODER_DEFAULTS.release,
  vocoderNoise: VOCODER_DEFAULTS.noise,
  vocoderGate: VOCODER_DEFAULTS.gate,
  metronome: false,
  countIn: false,
  // Leaving the sequencer or the drums drops what was playing onto a track.
  autoBounce: true,
  activePreset: null,
  hold: false,
  recording: false,
  // Per key: an octave offset, and modifiers locked to that key regardless of
  // what the modifier pad currently says.
  perKey: Array.from({ length: 7 }, () => ({ octave: 0, lock: null })),
  editingKey: 0,
  trainer: { level: 1, running: false, asked: 0, right: 0, last: null },
  sequence: [],
  sequenceAt: -1,
  strumSpeed: 'medium',
  instrument: 'warm',
  baseOctave: 4,
  sustain: 0.9,
  cutoff: 2500,
  volume: 0.85,
  modLayer: 'base',
  latched: [],
  momentary: [],
  // The modifier cells expanded into the chord modifiers they stand for, which
  // is what names a chord and what a locked key remembers.
  mods: [],
  held: [],
};

export const state = createStore(INITIAL_STATE);
