// What a held chord actually does. Every mode is a way of turning "these notes
// are held" into sound, and the clocked ones are driven by the transport rather
// than by timers of their own.

export const MODES = {
  play:      { label: 'play',   clocked: false },
  strum:     { label: 'strum',  clocked: false },
  lead:      { label: 'lead',   clocked: false },
  drone:     { label: 'drone',  clocked: false },
  arpeggio:  { label: 'arp',    clocked: true },
  repeat:    { label: 'repeat', clocked: true },
  drums:     { label: 'drums',  clocked: false },
  sequencer: { label: 'seq',    clocked: true },
};

export const MODE_IDS = Object.keys(MODES);

export const ARP_PATTERNS = ['up', 'down', 'updown', 'downup', 'random', 'fingerpick'];

// What the chord itself does while the arpeggiator runs.
export const ARP_CHORD_MODES = {
  arp: { label: 'arp only' },
  chord: { label: 'chord+arp' },
  rhythm: { label: 'rhythm+arp' },
};

export const ARP_CHORD_IDS = Object.keys(ARP_CHORD_MODES);

// The arpeggiator can hold the chord underneath itself, and then a key press
// has to sound something rather than waiting for the transport.
export function holdsChord(mode, arpChord) {
  return mode === 'arpeggio' && arpChord === 'chord';
}

export const STRUM_SPEEDS = { slow: 0.12, medium: 0.08, fast: 0.04 };

export function isSequencer(mode) {
  return mode === 'sequencer';
}

export function isDrums(mode) {
  return mode === 'drums';
}

export function isClocked(mode) {
  return Boolean(MODES[mode] && MODES[mode].clocked);
}

// The order the arpeggiator walks a chord in. Returned as note numbers so the
// caller does not have to know the pattern.
export function arpOrder(notes, pattern) {
  const up = notes.slice();
  switch (pattern) {
    case 'down':
      return up.reverse();
    case 'updown': {
      const down = up.slice(1, -1).reverse();
      return up.concat(down);
    }
    case 'downup': {
      const down = up.slice().reverse();
      return down.concat(up.slice(1, -1));
    }
    // The pattern a thumb and two fingers make: bass, top, middle, top.
    case 'fingerpick': {
      const last = up.length - 1;
      return [up[0], up[last], up[Math.min(1, last)], up[last]];
    }
    case 'random': {
      const shuffled = up.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }
    default:
      return up;
  }
}

// Which notes sound when a chord is pressed in this mode.
export function notesForPress(mode, notes) {
  if (mode === 'lead') return notes.slice(0, 1);
  return notes;
}
