// A band vocoder: the microphone shapes the chords.
//
// Both signals are split into the same set of frequency bands. For each band
// the microphone's loudness is measured and used as the gain of the same band
// of the chords, so whatever the voice is doing to its spectrum happens to
// theirs. Speak and the pad speaks; stop and it stops.
//
// The chords' side is a graph of nodes, because bandpass filters and gains are
// what a graph is for. The voice's side is a worklet, because the two things
// that make speech legible cannot be built from nodes at all: see vocoder-dsp.

import { WORKLET, createBandBank } from './vocoder-dsp.js';

// Bands spread across the range speech actually uses. More bands is more
// intelligible and more work; sixteen is the usual compromise.
const BANDS = 16;
const LOWEST = 120;
const HIGHEST = 7000;

// Every band is listened to through the shape of an average voice, so what
// opens a band is being louder than speech usually is there rather than being
// loud. A formant is exactly that, which is why this is what carries the words.
//
// Measured through these bands from a spoken sentence: speech peaks around
// 500 Hz, falls about 5 dB an octave below that and about 3.8 dB an octave
// above, reaching -15 dB by 7 kHz. A plain six decibels an octave, which is the
// figure usually quoted, overshoots the top by eight decibels and pins the top
// bands wide open on every syllable.
const SPEECH_PEAK = 500;
const FALL_BELOW = 5.0;
const FALL_ABOVE = 3.8;

export function speechTilt(frequency) {
  const octaves = Math.log2(frequency / SPEECH_PEAK);
  const quieterBy = octaves < 0 ? FALL_BELOW * -octaves : FALL_ABOVE * octaves;
  return Math.pow(10, quieterBy / 20);
}

// Only some bands are open at a time, so the sum sits below the carrier. Made
// up here, so that switching the vocoder on does not drop everything and invite
// the volume to be turned up, which is how a room with a microphone in it
// starts to howl. Measured against the same chord played dry.
const MAKE_UP = 1.3;

// How wide a band has to be to meet its neighbour. The bands are spaced evenly
// in octaves and a bandpass is this many times narrower than its own centre, so
// the width that closes the gap follows from the spacing and nothing else.
// Narrower and the bank is a comb at sixteen fixed pitches, which sounds like
// itself whatever is played through it: measured, a Q of eight passed the band
// centres nine decibels above the frequencies between them, and 3.7 passes them
// within one.
export function bandQ(count = BANDS, lowest = LOWEST, highest = HIGHEST) {
  const octaves = Math.log2(highest / lowest) / (count - 1);
  const edge = Math.pow(2, octaves / 2);
  return Math.round((1 / (edge - 1 / edge)) * 10) / 10;
}

export const VOCODER_DEFAULTS = {
  formant: 0,      // semitones the carrier bands are shifted by
  q: bandQ(),      // how narrow each band is: wide enough to meet its neighbour
  attack: 0.003,   // seconds for a band to open, which is a consonant
  release: 0.025,  // and to close, which is the tail of a vowel
  noise: 0.05,     // breath added to the carrier, for consonants
  gate: 0.02,      // below this the room is not a voice and nothing gets through
};

// Consonants are noise and a synth has none, but a voice's noise is all in the
// top: "s" and "sh" and "t" live between two and eight kilohertz and nothing
// about them is low. Mixed in flat it greys out the middle of the chord, where
// the instrument's own character is, so it goes in above this only.
const BREATH_FLOOR = 1500;

// How loud the chords have to be before any breath is added to them. Without
// this the breath is the carrier whenever no chord is held, so speaking into a
// silent keyboard produced a whisper out of nowhere.
const BREATH_SENSE = 12;

export function bandFrequencies(count = BANDS, lowest = LOWEST, highest = HIGHEST) {
  const step = Math.pow(highest / lowest, 1 / (count - 1));
  return Array.from({ length: count }, (_, i) => lowest * Math.pow(step, i));
}

const CURVE_POINTS = 1025;

function curve(fn) {
  const points = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < points.length; i++) {
    points[i] = fn((i / (points.length - 1)) * 2 - 1);
  }
  return points;
}

// An odd number of points, so one of them is exactly zero: with an even number
// the curve is read either side of zero and silence comes out as a thousandth
// of full scale, which is enough to hear the chords through a silent room.
function rectifier(ctx) {
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve(Math.abs);
  return shaper;
}

function clampCurve() {
  return curve(x => Math.max(0, Math.min(1, x)));
}

function noiseBuffer(ctx, seconds = 2) {
  const rate = ctx.sampleRate || 48000;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData ? buffer.getChannelData(0) : null;
  if (data) for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// The chords' loudness, smoothed, for opening the breath. A delay feeding back
// is a poor lowpass, but this only has to know whether a chord is being held.
function chordSense(ctx) {
  const rectify = rectifier(ctx);
  const smoothIn = ctx.createGain();
  const smooth = ctx.createGain();
  const hold = ctx.createDelay(1);
  const step = 128 / (ctx.sampleRate || 48000);
  hold.delayTime.value = step;
  const feedback = ctx.createGain();
  const keep = Math.min(0.999, Math.max(0, 1 - step / 0.05));
  feedback.gain.value = keep;
  smoothIn.gain.value = 1 - keep;
  rectify.connect(smoothIn);
  smoothIn.connect(smooth);
  smooth.connect(hold);
  hold.connect(feedback);
  feedback.connect(smooth);
  return { input: rectify, output: smooth };
}

// Once per context, not once per page: an offline render is its own context
// and has never heard of a module added to another one.
const loaded = new WeakMap();

function loadWorklet(ctx) {
  if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') return null;
  if (!loaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    loaded.set(ctx, Promise.resolve(ctx.audioWorklet.addModule(url))
      .finally(() => URL.revokeObjectURL(url)));
  }
  return loaded.get(ctx);
}

export function createVocoder(ctx, { bands = BANDS } = {}) {
  const carrier = ctx.createGain();     // the chords go in here
  const modulator = ctx.createGain();   // and the microphone here
  const output = ctx.createGain();
  output.gain.value = MAKE_UP;

  // What the bank splits: the chords, plus whatever breath they have earned.
  const voiced = ctx.createGain();
  carrier.connect(voiced);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  noise.loop = true;
  const breath = ctx.createBiquadFilter();
  breath.type = 'highpass';
  breath.frequency.value = BREATH_FLOOR;
  const noiseLevel = ctx.createGain();
  noiseLevel.gain.value = VOCODER_DEFAULTS.noise;
  const noiseGate = ctx.createGain();
  noiseGate.gain.value = 0;
  const sense = chordSense(ctx);
  const senseLevel = ctx.createGain();
  senseLevel.gain.value = BREATH_SENSE;
  const senseClamp = ctx.createWaveShaper();
  senseClamp.curve = clampCurve();
  carrier.connect(sense.input);
  sense.output.connect(senseLevel);
  senseLevel.connect(senseClamp);
  senseClamp.connect(noiseGate.gain);
  noise.connect(breath);
  breath.connect(noiseLevel);
  noiseLevel.connect(noiseGate);
  noiseGate.connect(voiced);
  if (typeof noise.start === 'function') noise.start(0);

  const centres = bandFrequencies(bands);
  const tilt = centres.map(speechTilt);

  const strip = centres.map((frequency) => {
    const speak = ctx.createBiquadFilter();
    speak.type = 'bandpass';
    speak.frequency.value = frequency;
    speak.Q.value = VOCODER_DEFAULTS.q;
    const opening = ctx.createGain();
    // Nothing gets through until the voice says so.
    opening.gain.value = 0;
    voiced.connect(speak);
    speak.connect(opening);
    opening.connect(output);
    return { frequency, speak, opening };
  });

  let analysis = null;
  let split = null;
  let settings = { ...VOCODER_DEFAULTS, tilt };
  let dead = false;

  const loading = loadWorklet(ctx);
  const ready = !loading ? Promise.resolve(false) : loading.then(() => {
    if (dead) return false;
    analysis = new AudioWorkletNode(ctx, 'vocoder-analysis', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [bands],
      processorOptions: { centres, settings },
    });
    split = ctx.createChannelSplitter(bands);
    modulator.connect(analysis);
    analysis.connect(split);
    strip.forEach((band, i) => split.connect(band.opening.gain, i));
    return true;
  }).catch(err => {
    console.warn('chordpad: no vocoder analysis', err);
    return false;
  });

  return {
    carrier,
    modulator,
    output,
    bands: strip,
    nodes: { noise, noiseLevel, noiseGate, breath, voiced, sense: sense.input },
    // What the analysis is doing, for anything that wants to measure it, and
    // when it is there at all: adding a worklet module is a round trip.
    analysis() { return analysis; },
    ready,

    apply({ formant = 0, q = VOCODER_DEFAULTS.q, attack = VOCODER_DEFAULTS.attack,
      release = VOCODER_DEFAULTS.release, noise: noiseAmount = VOCODER_DEFAULTS.noise,
      gate = VOCODER_DEFAULTS.gate } = {}) {
      const shift = Math.pow(2, formant / 12);
      noiseLevel.gain.value = Math.max(0, Math.min(1, noiseAmount));
      for (const band of strip) {
        // Only the chords' bands move: shifting what is listened to as well
        // would simply undo it. Moving one against the other is what makes a
        // voice sound taller or shorter than it is.
        band.speak.frequency.value = Math.min(ctx.sampleRate / 2 - 100, band.frequency * shift);
        band.speak.Q.value = q;
      }
      settings = { ...settings, q, attack, release, gate: Math.max(0, Math.min(0.5, gate)) };
      if (analysis) analysis.port.postMessage(settings);
    },

    settings() { return { ...settings }; },

    stop() {
      dead = true;
      try { noise.stop(); } catch { /* already stopped */ }
      if (analysis) try { analysis.disconnect(); } catch { /* already gone */ }
    },
  };
}

// The analysis on its own, for measuring what the voice does to the bands
// without a browser in the way.
export function analyse(rate, settings = {}) {
  const centres = bandFrequencies();
  return createBandBank(rate, centres, {
    ...VOCODER_DEFAULTS, tilt: centres.map(speechTilt), ...settings,
  });
}
