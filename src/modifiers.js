// Tap latches, hold applies only while held. The hardware joystick is momentary
// and springs back; latching is what makes the same gesture usable with one thumb.

export const HOLD_MS = 250;

// A cell may stand for several chord modifiers at once, so what is pressed and
// what is applied are two different things. expand is how one becomes the other.
export function createModifiers({ expand = ids => new Set(ids) } = {}) {
  const latchedSet = new Set();
  const pressedAt = new Map();

  return {
    press(id, time) {
      pressedAt.set(id, time);
    },
    release(id, time) {
      const started = pressedAt.get(id);
      pressedAt.delete(id);
      if (started === undefined) return;
      const wasHold = (time - started) >= HOLD_MS;
      if (wasHold) {
        // A hold never changes the latch: it applied while down, that is all.
        latchedSet.delete(id);
      } else if (latchedSet.has(id)) {
        latchedSet.delete(id);
      } else {
        latchedSet.add(id);
      }
    },
    active() {
      return expand([...latchedSet, ...pressedAt.keys()]);
    },
    // The cells themselves, for the pad that has to light them up.
    activeCells() {
      return new Set([...latchedSet, ...pressedAt.keys()]);
    },
    latched() {
      return new Set([...latchedSet].filter(id => !pressedAt.has(id)));
    },
    momentaryHeld() {
      return new Set(pressedAt.keys());
    },
    clear() {
      latchedSet.clear();
      pressedAt.clear();
    },
  };
}
