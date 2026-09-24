// Drum patterns as sixteen step grids, one row per drum. A 1 is a hit.
// Written out rather than generated: a pattern is a musical decision, and these
// are the ones that make each genre recognisable.

const P = (s) => s.split('').map(c => (c === 'x' ? 1 : 0));

export const PATTERNS = {
  off: null,
  rock: {
    label: 'rock',
    kick:      P('x......x..x.....'),
    snare:     P('....x.......x...'),
    hatClosed: P('x.x.x.x.x.x.x.x.'),
  },
  disco: {
    label: 'disco',
    kick:      P('x...x...x...x...'),
    snare:     P('....x.......x...'),
    hatOpen:   P('..x...x...x...x.'),
    hatClosed: P('x.x.x.x.x.x.x.x.'),
  },
  funk: {
    label: 'funk',
    kick:      P('x.....x...x..x..'),
    snare:     P('....x......x.x..'),
    hatClosed: P('xxxxxxxxxxxxxxxx'),
  },
  hiphop: {
    label: 'hip-hop',
    // Boom bap: the kick lands late and off the grid, the hats are busy
    // sixteenths with ghosts, and an open hat leads into the turnaround.
    kick:      P('x.....x...x.....'),
    snare:     P('....x.......x...'),
    hatClosed: P('x.xxx.x.x.xxx.x.'),
    hatOpen:   P('..............x.'),
  },
  reggae: {
    label: 'reggae',
    kick:      P('........x.......'),
    snare:     P('....x.......x...'),
    hatClosed: P('..x...x...x...x.'),
  },
  electro: {
    label: 'electro',
    // Four on the floor like disco, but with a pickup into the next bar, which
    // is what stops the two sounding like the same pattern with different hats.
    kick:      P('x...x...x...x.x.'),
    snare:     P('....x.......x...'),
    hatClosed: P('..x...x...x...x.'),
    hatOpen:   P('..............x.'),
  },
  jazz: {
    label: 'jazz',
    kick:      P('x.........x.....'),
    snare:     P('......x.....x..x'),
    ride:      P('x..x.xx..x.xx..x'),
  },
};

export const PATTERN_IDS = Object.keys(PATTERNS);

export const STEPS_PER_PATTERN = 16;

// A row named for a drum is played at full strength. These two are the same
// drum played quietly, which is what a ghost note is.
const QUIET_ROWS = {
  ghostSnare: { drum: 'snare', gain: 0.3 },
  ghostKick: { drum: 'kick', gain: 0.5 },
};

const EMPTY = () => new Array(STEPS_PER_PATTERN).fill(0);

function rows(pattern) {
  return Object.entries(pattern).filter(([name]) => name !== 'label');
}

function mapRows(pattern, fn) {
  const out = { label: pattern.label };
  for (const [name, row] of rows(pattern)) out[name] = fn(row, name);
  return out;
}

// The eight variations the device offers for every style. Each one is a
// transform rather than another grid written out by hand: the difference
// between rock and funk is a musical decision, but the difference between a
// beat and its half-time version is a rule, and a rule is worth stating once.
export const VARIATIONS = {
  original: {
    label: 'straight',
    apply: pattern => pattern,
  },
  ghosts: {
    label: 'ghosts',
    // Quiet snares on the last sixteenth of each beat, where the hand would
    // fall between the backbeats.
    apply: (pattern) => {
      const snare = pattern.snare || EMPTY();
      const ghostSnare = EMPTY();
      for (let i = 3; i < STEPS_PER_PATTERN; i += 4) if (!snare[i]) ghostSnare[i] = 1;
      return { ...pattern, ghostSnare };
    },
  },
  busy: {
    label: 'busy hats',
    // Sixteenths all the way, and an open hat at the end of each half bar so a
    // pattern whose hats were already busy still has somewhere to go.
    apply: (pattern) => {
      if (!pattern.hatClosed && !pattern.ride) return pattern;
      const key = pattern.hatClosed ? 'hatClosed' : 'ride';
      const hatOpen = (pattern.hatOpen || EMPTY()).slice();
      hatOpen[7] = 1;
      hatOpen[15] = 1;
      return { ...pattern, hatOpen, [key]: EMPTY().map((_, i) => (hatOpen[i] ? 0 : 1)) };
    },
  },
  syncopated: {
    label: 'sync kicks',
    // Every kick but the downbeat is pushed a sixteenth late, which is what
    // turns a steady pattern into one that leans.
    apply: (pattern) => {
      if (!pattern.kick) return pattern;
      const kick = EMPTY();
      pattern.kick.forEach((hit, i) => {
        if (!hit) return;
        kick[i === 0 ? 0 : (i + 1) % STEPS_PER_PATTERN] = 1;
      });
      return { ...pattern, kick };
    },
  },
  fill: {
    label: 'fill',
    // The last beat is given over to a fill, so the bar turns around.
    apply: (pattern) => {
      const clean = mapRows(pattern, row => row.map((hit, i) => (i >= 12 ? 0 : hit)));
      const snare = clean.snare || EMPTY();
      const tom = clean.tom || EMPTY();
      snare[12] = 1;
      snare[14] = 1;
      tom[13] = 1;
      tom[15] = 1;
      return { ...clean, snare, tom };
    },
  },
  halfTime: {
    label: 'half time',
    // The first half of the bar stretched across all of it: the backbeat lands
    // on three instead of two and four.
    apply: (pattern) => {
      const out = mapRows(pattern, (row) => {
        const stretched = EMPTY();
        for (let i = 0; i < STEPS_PER_PATTERN / 2; i++) if (row[i]) stretched[i * 2] = 1;
        return stretched;
      });
      // A beat whose kick all sat in the second half of the bar would lose it
      // altogether, and a half-time groove with no downbeat is not a groove.
      if (out.kick && !out.kick.some(Boolean)) out.kick[0] = 1;
      return out;
    },
  },
  doubleTime: {
    label: 'double time',
    // The bar squeezed into half of it and played twice.
    apply: pattern => mapRows(pattern, (row) => {
      const out = EMPTY();
      for (let i = 0; i < STEPS_PER_PATTERN; i++) out[i] = row[(i % 8) * 2] ? 1 : 0;
      return out;
    }),
  },
  jazz: {
    label: 'jazz',
    // A ride pattern in place of the hats, and the rest thinned to comping.
    apply: (pattern) => {
      const thin = mapRows(pattern, (row, name) => (name === 'kick' || name === 'snare'
        ? row.map((hit, i) => (i % 2 === 0 ? hit : 0))
        : EMPTY()));
      return { ...thin, hatClosed: undefined, hatOpen: undefined, ride: P('x..x.xx..x.xx..x') };
    },
  },
};

export const VARIATION_IDS = Object.keys(VARIATIONS);

// Seven styles times eight variations is the device's fifty six loops, built
// from seven grids and eight rules rather than fifty six grids.
export function patternFor(patternId, variationId = 'original') {
  const pattern = PATTERNS[patternId];
  if (!pattern) return null;
  const variation = VARIATIONS[variationId] || VARIATIONS.original;
  const made = variation.apply(pattern);
  // A transform may take a row away by leaving it undefined.
  return Object.fromEntries(Object.entries(made).filter(([, row]) => row !== undefined));
}

// Which drums fire on this step of the grid, and how hard.
export function hitsAt(patternId, step, variationId = 'original') {
  const pattern = patternFor(patternId, variationId);
  if (!pattern) return [];
  const index = ((step % STEPS_PER_PATTERN) + STEPS_PER_PATTERN) % STEPS_PER_PATTERN;
  const hits = [];
  for (const [name, row] of rows(pattern)) {
    if (!row[index]) continue;
    const quiet = QUIET_ROWS[name];
    hits.push(quiet ? { ...quiet } : { drum: name, gain: 1 });
  }
  return hits;
}
