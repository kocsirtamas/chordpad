// Note rates, as offsets inside one transport step. The transport runs on
// sixteenths, so anything slower fires on some steps and not others, and
// anything faster, swung or triplet falls between them. One table serves the
// arpeggiator, repeat and auto-drum, because they are all the same question:
// where in this step does a hit land, and how long is it.

// steps: how many sixteenth steps one hit lasts, which is what a note length
// is measured in. at: the offsets within this step, in seconds.
const RATES = {
  '1/1':   { steps: 16, at: step => (step % 16 === 0 ? [0] : []) },
  '1/2':   { steps: 8,  at: step => (step % 8 === 0 ? [0] : []) },
  '1/4':   { steps: 4,  at: step => (step % 4 === 0 ? [0] : []) },
  '1/8':   { steps: 2,  at: step => (step % 2 === 0 ? [0] : []) },
  '1/16':  { steps: 1,  at: () => [0] },
  // Six to the beat, so they are laid out a beat at a time.
  '1/16T': { steps: 2 / 3, at: (step, d) => (step % 4 === 0
    ? [0, d * (2 / 3), d * (4 / 3), d * 2, d * (8 / 3), d * (10 / 3)]
    : []) },
  '1/32':  { steps: 0.5, at: (step, d) => [0, d / 2] },
  // Swung eighths: the offbeat lands two thirds of the way through the beat
  // rather than halfway, which is the whole point of a shuffle.
  swing8:  { steps: 2, at: (step, d) => {
    if (step % 4 === 0) return [0];
    return step % 4 === 2 ? [d * (2 / 3)] : [];
  } },
  // Swung sixteenths: every step, with the offbeats pushed late.
  swing16: { steps: 1, at: (step, d) => (step % 2 === 0 ? [0] : [d / 3]) },
};

export const RATE_IDS = Object.keys(RATES);

export function offsetsAt(rate, step, stepDuration) {
  const entry = RATES[rate];
  return entry ? entry.at(step, stepDuration) : [];
}

// How long one note at this rate lasts, in transport steps.
export function stepsPerHit(rate) {
  const entry = RATES[rate];
  return entry ? entry.steps : 1;
}
