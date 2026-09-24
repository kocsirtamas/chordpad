// Pure music theory. No audio, no DOM, no imports. Everything here is total:
// any degree index with any subset of MODIFIERS produces a chord.

export const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Semitone steps from the key root. Five and six note scales are allowed: the
// degree index simply wraps into the next octave, so all seven keys always play.
export const SCALES = {
  major:      { name: 'Major',          steps: [0, 2, 4, 5, 7, 9, 11] },
  minor:      { name: 'Natural Minor',  steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonic:   { name: 'Harmonic Minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  melodic:    { name: 'Melodic Minor',  steps: [0, 2, 3, 5, 7, 9, 11] },
  majorPent:  { name: 'Major Pentatonic', steps: [0, 2, 4, 7, 9] },
  minorPent:  { name: 'Minor Pentatonic', steps: [0, 3, 5, 7, 10] },
  blues:      { name: 'Blues',          steps: [0, 3, 5, 6, 7, 10] },
  dorian:     { name: 'Dorian',         steps: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { name: 'Mixolydian',     steps: [0, 2, 4, 5, 7, 9, 10] },
  lydian:     { name: 'Lydian',         steps: [0, 2, 4, 6, 7, 9, 11] },
};

export const SCALE_IDS = Object.keys(SCALES);

export const DEGREE_COUNT = 7;

// Display order of the pad: 2 4 6 across the short top row, 1 3 5 7 across the
// long bottom row, as degree indices.
export const PAD_ORDER = [1, 3, 5, 0, 2, 4, 6];

// The eight joystick directions of the device, as ids.
export const MODIFIERS = ['minmaj', 'dom7', 'maj7', 'add9', 'sus4', 'six', 'dim', 'aug'];

// The extended and chromatic layers are built from these. Each one only adds a
// note, so any combination of them is still a chord rather than a special case.
const EXTENSIONS = {
  dimSeven: 9,   // a true diminished seventh, not the sixth it shares a pitch with
  majSeven: 11,  // a major seventh whatever the triad under it, which is what makes minMaj7
  flatNine: 13,
  sharpNine: 15,
  eleven: 17,
  sharpEleven: 18,
  flatThirteen: 20,
  thirteen: 21,
};

export const EXTENSION_IDS = Object.keys(EXTENSIONS);

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

function stepsOf(scaleId) {
  return (SCALES[scaleId] || SCALES.major).steps;
}

// Index may run past the end of the scale; it wraps and rises an octave.
function scaleNote(steps, index) {
  const len = steps.length;
  const wrapped = ((index % len) + len) % len;
  return steps[wrapped] + 12 * Math.floor(index / len);
}

export function rootOf(keyRoot, degreeIndex, scaleId = 'major') {
  return (keyRoot + scaleNote(stepsOf(scaleId), degreeIndex)) % 12;
}

// The chord this degree makes by stacking scale tones, which is what makes a
// scale sound like itself rather than like a major scale with a different name.
export function triadFor(degreeIndex, scaleId = 'major') {
  const steps = stepsOf(scaleId);
  const root = scaleNote(steps, degreeIndex);
  return [
    0,
    scaleNote(steps, degreeIndex + 2) - root,
    scaleNote(steps, degreeIndex + 4) - root,
  ];
}

function classify(third, fifth) {
  if (third === 4 && fifth === 8) return 'aug';
  if (third === 3 && fifth === 6) return 'dim';
  if (third === 4) return 'maj';
  if (third === 3) return 'min';
  if (third <= 2) return 'sus2';
  if (third === 5) return 'sus4';
  return fifth === 6 ? 'dim' : 'maj';
}

export function qualityFor(degreeIndex, mods, scaleId = 'major') {
  const [, third, fifth] = intervalsFor(degreeIndex, mods, scaleId).length
    ? baseIntervals(degreeIndex, mods, scaleId)
    : [0, 4, 7];
  return classify(third, fifth);
}

// The triad after the modifiers that replace notes, before the ones that add.
function baseIntervals(degreeIndex, mods, scaleId) {
  const [, third, fifth] = triadFor(degreeIndex, scaleId);
  let t = third;
  let f = fifth;

  if (mods.has('minmaj')) {
    if (t === 4) t = 3;
    else if (t === 3) t = 4;
  }
  // Forcing a third, rather than flipping whatever the scale gave us: an
  // extended chord names its own quality and must not depend on the degree.
  if (mods.has('min')) t = 3;
  if (mods.has('maj')) t = 4;
  if (mods.has('dim')) { t = 3; f = 6; }
  if (mods.has('aug')) { t = 4; f = 8; }
  if (mods.has('sus4')) t = 5;

  return [0, t, f];
}

export function intervalsFor(degreeIndex, mods, scaleId = 'major') {
  const base = baseIntervals(degreeIndex, mods, scaleId);
  const quality = classify(base[1], base[2]);
  const out = base.slice();

  if (mods.has('six')) out.push(9);
  if (mods.has('dom7')) out.push(10);
  else if (mods.has('maj7')) out.push(quality === 'maj' || quality === 'aug' ? 11 : 10);
  if (mods.has('add9')) out.push(14);

  for (const [id, interval] of Object.entries(EXTENSIONS)) {
    if (mods.has(id)) out.push(interval);
  }

  // Two modifiers can name the same pitch, and a chord wants it once.
  return [...new Set(out)].sort((a, b) => a - b);
}

// Chords the ear knows by a name of their own. Matched on everything above the
// triad, so the same shape is named the same way whatever quality it sits on:
// with a minor third, ['dom7', 'add9'] is m9, and with a major third it is 9.
const SHAPES = [
  { mods: ['dom7', 'flatNine', 'sharpNine', 'flatThirteen'], name: '7alt' },
  { mods: ['dom7', 'add9', 'thirteen'], name: '13' },
  { mods: ['majSeven', 'add9', 'thirteen'], name: 'maj13' },
  { mods: ['dom7', 'add9', 'eleven'], name: '11' },
  { mods: ['majSeven', 'sharpEleven'], name: 'maj7#11' },
  { mods: ['dom7', 'sharpNine'], name: '7#9' },
  { mods: ['dom7', 'flatNine'], name: '7b9' },
  { mods: ['dom7', 'add9'], name: '9' },
  { mods: ['six', 'add9'], name: '6/9' },
  { mods: ['majSeven'], name: 'maj7' },
  { mods: ['dimSeven'], name: '7' },
  { mods: ['eleven'], name: 'add11' },
  // Last, and only so a suspended seventh is written C7sus4 rather than Csus47.
  { mods: ['dom7'], name: '7' },
];

// What sits above the triad. The modifiers that shape the triad itself are the
// chord's quality, not part of its shape.
const TRIAD_MODS = new Set(['minmaj', 'min', 'maj', 'dim', 'aug', 'sus4']);

function shapeFor(mods) {
  const above = [...mods].filter(id => !TRIAD_MODS.has(id));
  return SHAPES.find(shape => shape.mods.length === above.length
    && shape.mods.every(id => mods.has(id)));
}

const QUALITY_SUFFIX = { maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4' };

const EXTENSION_NAMES = {
  dimSeven: '7', majSeven: 'maj7', flatNine: 'b9', sharpNine: '#9',
  eleven: 'add11', sharpEleven: '#11', flatThirteen: 'b13', thirteen: '13',
};

export function chordName(keyRoot, degreeIndex, mods, scaleId = 'major') {
  const base = baseIntervals(degreeIndex, mods, scaleId);
  const quality = classify(base[1], base[2]);
  const root = NOTE_NAMES[rootOf(keyRoot, degreeIndex, scaleId)];
  const seventh = mods.has('dom7') || mods.has('maj7');

  // A diminished triad with a minor seventh is half diminished, and writing it
  // "dim7" would name a different chord: a true dim7 has a diminished seventh.
  if (quality === 'dim' && seventh) {
    let name = `${root}m7b5`;
    if (mods.has('add9')) name += 'add9';
    return name;
  }

  // A named shape wins over spelling the chord out one modifier at a time.
  const shape = shapeFor(mods);
  if (shape) {
    // A suspended chord is written with the suspension last: C9sus4, not Csus49.
    const suffix = QUALITY_SUFFIX[quality];
    return quality === 'sus4' || quality === 'sus2'
      ? root + shape.name + suffix
      : root + suffix + shape.name;
  }

  let name = root + QUALITY_SUFFIX[quality];
  if (mods.has('six')) name += '6';
  if (mods.has('dom7')) name += '7';
  else if (mods.has('maj7')) name += (quality === 'maj' || quality === 'aug') ? 'maj7' : '7';
  if (mods.has('add9')) name += 'add9';
  for (const id of EXTENSION_IDS) {
    if (mods.has(id)) name += EXTENSION_NAMES[id];
  }

  return name;
}

// Roman numeral for the pad, capitalised for major and lowered for minor, the
// way a chord chart writes it.
export function numeralFor(degreeIndex, scaleId = 'major') {
  const [, third, fifth] = triadFor(degreeIndex, scaleId);
  const quality = classify(third, fifth);
  const numeral = ROMAN[degreeIndex % ROMAN.length];
  if (quality === 'min') return numeral.toLowerCase();
  if (quality === 'dim') return numeral.toLowerCase() + '°';
  if (quality === 'aug') return numeral + '+';
  return numeral;
}

export function voicing(keyRoot, degreeIndex, mods, baseOctave, scaleId = 'major', options = {}) {
  const steps = stepsOf(scaleId);
  const root = baseOctave * 12 + keyRoot + scaleNote(steps, degreeIndex);
  let notes = intervalsFor(degreeIndex, mods, scaleId).map(i => root + i);

  if (options.inversion) notes = invert(notes, options.inversion);
  if (options.voiceLeading) notes = leadVoicing(notes, options.previous);
  return withBass(notes, options.bass, root);
}

// Rotate the lowest note up an octave, as many times as asked. Three inversions
// of a triad, four of a seventh chord, and then it is back where it started.
export function invert(notes, inversion) {
  const out = notes.slice().sort((a, b) => a - b);
  for (let i = 0; i < inversion; i++) out.push(out.shift() + 12);
  return out.sort((a, b) => a - b);
}

// How far the fingers would have to move between two voicings.
function movement(from, to) {
  let total = 0;
  for (const note of to) {
    let nearest = Infinity;
    for (const other of from) nearest = Math.min(nearest, Math.abs(note - other));
    total += nearest;
  }
  return total / to.length;
}

// The inversion that moves least from what was playing before, which is what
// makes a progression sound joined up rather than jumping around the keyboard.
export function leadVoicing(notes, previous) {
  if (!previous || previous.length === 0) return notes;
  let best = notes;
  let bestScore = Infinity;
  for (let inversion = 0; inversion < notes.length; inversion++) {
    for (const octave of [-12, 0]) {
      const candidate = invert(notes, inversion).map(n => n + octave);
      const score = movement(previous, candidate);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }
  return best;
}

// OFF leaves the chord alone, ROOT doubles the root two octaves down, which is
// what stops a high voicing sounding thin.
export function withBass(notes, mode, rootSemitone) {
  if (mode !== 'root' || notes.length === 0) return notes;
  const lowest = Math.min(...notes);
  let bass = rootSemitone;
  while (bass > lowest - 12) bass -= 12;
  return [bass, ...notes];
}

// A4 is 440 Hz and sits at absolute semitone 57 counting from C0.
export function frequency(absSemitone) {
  return 440 * Math.pow(2, (absSemitone - 57) / 12);
}

export function noteNamesOf(keyRoot, degreeIndex, mods, scaleId = 'major') {
  const root = rootOf(keyRoot, degreeIndex, scaleId);
  return intervalsFor(degreeIndex, mods, scaleId).map(i => NOTE_NAMES[(root + i) % 12]);
}

// Kept for the pad, which labels buttons 1..7 whatever the scale.
export const DEGREES = Array.from({ length: DEGREE_COUNT }, (_, i) => ({
  numeral: ROMAN[i],
  offset: SCALES.major.steps[i],
}));
