// Changes that wait for the downbeat.
//
// Changing key, or sound, or mode, in the middle of a bar is heard as a change
// in the middle of a bar. Doing it on the beat means timing it by hand, and a
// hand cannot time it: the change has to be made a little early to land on
// time, and how early depends on the tempo.
//
// So a change can be held instead. What is held is the last value asked for,
// not every value on the way: reaching for a key and going past it should land
// on the key that was settled on, not play the ones passed through.
//
// Only what is worth waiting for. A volume, a reverb mix, a slider being
// dragged: those want to happen while the hand is moving, and holding them
// until the downbeat would make the instrument feel broken rather than musical.

export const QUEUED_KEYS = [
  // Which notes the keys play.
  'keyRoot', 'scale', 'baseOctave', 'inversion', 'voiceLeading', 'bass',
  // What they sound like.
  'instrument', 'adsr', 'stereo', 'voices',
  // And what pressing one does.
  'mode', 'arpPattern', 'arpRate', 'arpChord', 'strumSpeed', 'beat', 'kit',
  'beatVariation', 'autoDrum',
];

const QUEUED = new Set(QUEUED_KEYS);

export function isQueueable(key) {
  return QUEUED.has(key);
}

// Sixteen sixteenths, which is what the transport counts a bar as.
const STEPS_PER_BAR = 16;

export function createQueue({ state, clock, onPending = null }) {
  let waiting = {};
  let armed = false;

  function pending() {
    return { ...waiting };
  }

  function announce() {
    if (onPending) onPending(pending());
  }

  function flush() {
    const changes = waiting;
    waiting = {};
    armed = false;
    if (Object.keys(changes).length === 0) return false;
    state.set(changes);
    announce();
    return true;
  }

  // Held for the next downbeat, and only the last value asked for: going past
  // the key you wanted on the way to it should not play the ones you passed.
  function hold(patch) {
    let held = false;
    const now = {};
    for (const [key, value] of Object.entries(patch)) {
      if (isQueueable(key)) {
        waiting[key] = value;
        held = true;
      } else {
        now[key] = value;
      }
    }
    if (Object.keys(now).length > 0) state.set(now);
    if (held) {
      if (!armed) {
        armed = true;
        // A downbeat is only a moment while something is counting them.
        if (clock && !clock.isRunning()) clock.start();
      }
      announce();
    }
    return held;
  }

  return {
    pending,
    hold,
    // Nothing is waiting for anything: used when the option is switched off,
    // so what was already asked for still happens rather than being lost.
    flushNow() { return flush(); },
    drop() {
      waiting = {};
      armed = false;
      announce();
    },
    // Called for every step the transport emits.
    step(number) {
      if (!armed || number % STEPS_PER_BAR !== 0) return false;
      return flush();
    },
  };
}
