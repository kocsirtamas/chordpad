// A step sequencer: a short chord progression, entered a chord at a time and
// played back by the transport. It holds the pattern and works out what belongs
// on a given step; it makes no sound and knows nothing about the engine.

export const MAX_STEPS = 16;

// One chord per beat, and the transport counts sixteenths.
export const STEPS_PER_CHORD = 4;

export function createSequencer({ maxSteps = MAX_STEPS } = {}) {
  let steps = [];
  // Where the pattern begins on the transport. Without it the progression
  // starts wherever the clock happens to be, so a freshly written sequence
  // could come in on its third chord.
  let origin = 0;

  return {
    startAt(transportStep) {
      origin = transportStep;
    },
    steps() {
      return steps.slice();
    },
    length() {
      return steps.length;
    },
    isEmpty() {
      return steps.length === 0;
    },

    // Appends a chord, unless the pattern is full.
    add(step, transportStep) {
      if (steps.length >= maxSteps) return false;
      // The first chord of an empty pattern sets where the pattern starts.
      if (steps.length === 0 && transportStep !== undefined) origin = transportStep;
      steps.push(step);
      return true;
    },

    // Replaces one, which is how a wrong chord is corrected without starting again.
    replace(index, step) {
      if (index < 0 || index >= steps.length) return false;
      steps[index] = step;
      return true;
    },

    removeLast() {
      steps.pop();
      return steps.length;
    },

    clear() {
      steps = [];
    },

    // Which chord, if any, starts on this transport step. Returns null between
    // chords, so the caller strikes only on the beat.
    chordAt(transportStep) {
      if (steps.length === 0) return null;
      const since = transportStep - origin;
      if (since < 0 || since % STEPS_PER_CHORD !== 0) return null;
      const beat = Math.floor(since / STEPS_PER_CHORD);
      const index = ((beat % steps.length) + steps.length) % steps.length;
      return { index, step: steps[index] };
    },

    // How long the whole pattern lasts, in transport steps.
    lengthInSteps() {
      return steps.length * STEPS_PER_CHORD;
    },
  };
}
