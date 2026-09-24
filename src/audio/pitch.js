// Working out what note is being sung or played, from samples alone.
//
// Autocorrelation rather than an FFT: the question is "what does this signal
// repeat at", which is what autocorrelation answers directly, and a voice or a
// guitar string repeats long before its spectrum is easy to read. Everything
// here is pure, so it can be tested against a tone whose pitch is known.

// Below this there is nothing worth calling a pitch, only room noise. Kept low
// on purpose: gain control is switched off for the microphone, so a voice at a
// polite distance arrives quieter than it sounds, and the correlation
// threshold below is what actually rejects noise. Noise correlates with itself
// badly, however loud it is.
const SILENCE_RMS = 0.004;

// The range a person sings or an instrument is played in. Wider than it needs
// to be at both ends, narrow enough that an octave error cannot hide in it.
export const PITCH_RANGE = { min: 55, max: 1600 };

export function rms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// The frequency the samples repeat at, or null when there is nothing to hear.
//
// The measure is the normalised square difference: how well the signal matches
// itself at a given lag, scaled by the energy in both halves so that a long lag
// is not quietly favoured over a short one. The peak to take is then the first
// one that is nearly as good as the best, not the best itself: a signal
// correlates with itself at every multiple of its period, so the tallest peak
// is an octave down about as often as it is right.
const NEARLY = 0.85;

export function detectPitch(samples, sampleRate, { min = PITCH_RANGE.min, max = PITCH_RANGE.max } = {}) {
  if (!samples || samples.length < 2 || !sampleRate) return null;
  if (rms(samples) < SILENCE_RMS) return null;

  const shortest = Math.max(2, Math.floor(sampleRate / max));
  const longest = Math.min(Math.floor(samples.length / 2), Math.ceil(sampleRate / min));
  if (longest <= shortest) return null;

  const scores = new Float32Array(longest + 1);
  for (let lag = shortest; lag <= longest; lag++) {
    let product = 0;
    let energy = 0;
    for (let i = 0; i < samples.length - lag; i++) {
      product += samples[i] * samples[i + lag];
      energy += samples[i] * samples[i] + samples[i + lag] * samples[i + lag];
    }
    scores[lag] = energy > 0 ? (2 * product) / energy : 0;
  }

  let strongest = 0;
  for (let lag = shortest; lag <= longest; lag++) strongest = Math.max(strongest, scores[lag]);
  if (strongest < 0.3) return null;

  const wanted = strongest * NEARLY;
  for (let lag = shortest + 1; lag < longest; lag++) {
    const peak = scores[lag] > scores[lag - 1] && scores[lag] >= scores[lag + 1];
    if (peak && scores[lag] >= wanted) return sampleRate / refine(scores, lag);
  }
  return null;
}

// The true peak lies between two samples, and at these lags one sample is
// several cents. Fitting a parabola to its neighbours finds it.
function refine(scores, lag) {
  const before = scores[lag - 1];
  const at = scores[lag];
  const after = scores[lag + 1];
  const divisor = 2 * (2 * at - before - after);
  if (divisor === 0) return lag;
  const shift = (after - before) / divisor;
  return Math.abs(shift) < 1 ? lag + shift : lag;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// A4 is 440 Hz and MIDI note 69, which is the whole of the tuning.
export function semitoneOf(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

export function frequencyOf(semitone) {
  return 440 * Math.pow(2, (semitone - 69) / 12);
}

// The note a frequency is nearest to, and how far off it is in cents: a
// hundredth of a semitone, which is the unit every tuner is marked in.
export function nearestNote(frequency) {
  if (!frequency || frequency <= 0) return null;
  const exact = semitoneOf(frequency);
  const semitone = Math.round(exact);
  return {
    semitone,
    name: NAMES[((semitone % 12) + 12) % 12],
    octave: Math.floor(semitone / 12) - 1,
    cents: Math.round((exact - semitone) * 100),
    frequency,
  };
}
