// The ADSR slots. The device offers a fixed set of shapes rather than four
// sliders, and the shape is what people actually reach for, so the same set is
// offered here. "off" leaves the instrument's own envelope alone.

// Times in seconds, sustain as a fraction of the peak.
export const ENVELOPES = {
  off:     null,
  long:    { attack: 0.8,   decay: 1.0,  sustain: 0.7,  release: 2.0 },
  short:   { attack: 0.1,   decay: 0.1,  sustain: 1.0,  release: 0.12 },
  swell:   { attack: 0.8,   decay: 0.3,  sustain: 0.8,  release: 2.0 },
  pluck:   { attack: 0.005, decay: 0.08, sustain: 0.0,  release: 0.18 },
  touch:   { attack: 0.025, decay: 0.26, sustain: 0.66, release: 0.45 },
  sustain: { attack: 0.2,   decay: 0.3,  sustain: 0.85, release: 3.0 },
};

export const ENVELOPE_IDS = Object.keys(ENVELOPES);

export function envelopeFor(id) {
  return ENVELOPES[id] || null;
}
