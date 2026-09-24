// The instrument list. Each entry says which engine builds the voice and with
// what settings, so adding a sound never means touching the engine.

// Sampled instruments are declared next to the synthesised ones, because from
// everywhere else in the app they are the same thing: an id that makes a sound.
// note is the pitch the recording was made at; the nearest one to what is played
// is the one used, so nothing is shifted more than a few semitones.
const SAMPLE_NOTES = [36, 42, 48, 54, 60, 66, 72, 78, 84];

// trim is how much an instrument is turned up or down so that all of them sit
// at the same loudness. Not guessed: each one was rendered playing the same
// chord and measured K weighted, the way a loudness meter does, because plain
// RMS says a sine and a sawtooth are equally loud and no ear agrees. The set
// spanned nearly twenty decibels, the sampled instruments sitting well below
// the synthesised ones and a sine or triangle a few below a square or a saw.
// The measurement lives with the tests, where it can use a browser:
//   cd tests && python3 -m pytest test_e2e.py -q -k same_loudness -s
// prints the table, and trim = 10 ** (-(measured - median) / 20).

function sampled(id, label, fallback, extra = {}) {
  return {
    id,
    label,
    kind: 'sample',
    // Until the recordings arrive, the instrument plays on this, so choosing a
    // sound never leaves the pad silent.
    fallback,
    samples: SAMPLE_NOTES.map(note => ({ note, file: `${id}-${note}.mp3` })),
    ...extra,
  };
}

export const INSTRUMENTS = {
  warm:      { label: 'warm', trim: 0.75,      kind: 'analog', layers: [{ type: 'sine', detune: 6 }] },
  tri:       { label: 'tri', trim: 0.92,       kind: 'analog', layers: [{ type: 'triangle', detune: 3 }], release: 0.5 },
  pluck:     { label: 'pluck',     kind: 'analog', layers: [{ type: 'sawtooth', detune: 2 }], release: 0.35 },
  organ:     { label: 'organ', trim: 0.6,     kind: 'analog', layers: [{ type: 'square', detune: 0 }] },
  saw:       { label: 'saw',       kind: 'analog', layers: [{ type: 'sawtooth', detune: 0 }] },
  saws:      { label: 'saws', trim: 0.7,      kind: 'analog', attack: 0.25,
               layers: [{ type: 'sawtooth', detune: -7 }, { type: 'sawtooth', detune: 7 }] },
  junoPoly:  { label: 'juno', trim: 0.64,      kind: 'analog',
               layers: [{ type: 'sawtooth', detune: -9 }, { type: 'square', detune: 9, gain: 0.7 }] },
  oceanPad:  { label: 'pad', trim: 0.61,       kind: 'analog', attack: 0.5,
               layers: [{ type: 'sine', detune: -5 }, { type: 'triangle', detune: 5 }] },
  sawSquare: { label: 'sawsquare', trim: 0.77, kind: 'analog',
               layers: [{ type: 'sawtooth', detune: 0 }, { type: 'square', detune: 12, gain: 0.5 }] },
  fmEPiano:  { label: 'e.piano', trim: 0.78,   kind: 'fm', ratio: 1, index: 2.5, curve: 2, release: 0.6 },
  fmBell:    { label: 'bell', trim: 0.74,      kind: 'fm', ratio: 3.5, index: 4, curve: 4, release: 1.2 },
  fmHX7:     { label: 'hx7', trim: 0.88,       kind: 'fm', ratio: 2, index: 1.6, curve: 3 },

  piano:    sampled('piano', 'piano', 'tri', { trim: 3.22, release: 0.6 }),
  wurli:    sampled('wurli', 'wurli', 'fmEPiano', { trim: 3.41, release: 0.5 }),
  vibes:    sampled('vibes', 'vibes', 'fmBell', { trim: 3.33, release: 1.0 }),
  guitar:   sampled('guitar', 'guitar', 'pluck', { trim: 3.01, release: 0.5 }),
  harp:     sampled('harp', 'harp', 'pluck', { trim: 3.52, release: 0.8 }),
  strings:  sampled('strings', 'strings', 'saws', { trim: 5.85, attack: 0.12 }),
  brass:    sampled('brass', 'brass', 'sawSquare', { trim: 4.14, attack: 0.06 }),
  clarinet: sampled('clarinet', 'clarinet', 'oceanPad', { trim: 3.94, attack: 0.05 }),
  flute:    sampled('flute', 'flute', 'warm', { trim: 4.26, attack: 0.06 }),
  choir:    sampled('choir', 'choir', 'oceanPad', { trim: 5.4, attack: 0.15 }),
  voices:   sampled('voices', 'voices', 'oceanPad', { trim: 3.45, attack: 0.15 }),

  // Whatever was last recorded through the microphone. It has no files: the
  // sample library is handed the buffer directly, and until it is the fallback
  // plays, the same as for an instrument whose files have not arrived.
  mic: { id: 'mic', label: 'mic', kind: 'sample', fallback: 'warm', samples: [], recorded: true, trim: 1 },
};

export const RECORDED_IDS = Object.keys(INSTRUMENTS).filter(id => INSTRUMENTS[id].recorded);

export const SAMPLED_IDS = Object.keys(INSTRUMENTS).filter(id => INSTRUMENTS[id].kind === 'sample');
export const SYNTH_IDS = Object.keys(INSTRUMENTS).filter(id => INSTRUMENTS[id].kind !== 'sample');

export function isSampled(id) {
  const preset = INSTRUMENTS[id];
  return Boolean(preset && preset.kind === 'sample');
}

export const INSTRUMENT_IDS = Object.keys(INSTRUMENTS);

export function instrumentFor(id) {
  return INSTRUMENTS[id] || INSTRUMENTS.warm;
}
