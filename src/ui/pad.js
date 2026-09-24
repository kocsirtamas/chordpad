import { PAD_ORDER, chordName, numeralFor } from '../theory.js';
import { DRUM_MAP } from '../audio/drums.js';

// The seven chord keys, three short over four long, in the device's arrangement.

export function renderPad(refs, { onDown, onUp, onSlide, onLeave, isHolding = () => true }) {
  const keys = new Map();

  // Touch pointers are implicitly captured by the element they started on, so a
  // finger dragged across the pad keeps reporting to the first key. Work out
  // what is actually under it instead, the way real keys behave.
  const degreeUnder = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const key = el && el.closest ? el.closest('.k') : null;
    return key ? Number(key.dataset.degree) : null;
  };

  PAD_ORDER.forEach((degreeIndex, position) => {
    const el = document.createElement('div');
    el.className = 'k';
    el.dataset.degree = String(degreeIndex);
    el.innerHTML = `
      <span class="deg">${degreeIndex + 1}</span>
      <span class="rn"></span>
      <span class="nm"></span>`;

    el.addEventListener('pointerdown', e => {
      onDown(degreeIndex, e.pointerId);
      // Capture keeps the release on this key if the finger slides off, but it
      // is best effort: never let it stop the note from sounding.
      try { el.setPointerCapture(e.pointerId); } catch { /* no active pointer */ }
    });
    const up = e => onUp(degreeIndex, e.pointerId);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);

    (position < 3 ? refs.padTop : refs.padBottom).appendChild(el);
    keys.set(degreeIndex, el);
  });

  // The keys are labelled 1 to 7, so those keys on a keyboard play them. Held
  // for as long as the key is down, like a finger. Pointer ids are invented from
  // the degree so a keyboard note and a pointer on the same key cannot collide.
  const KEYBOARD_POINTER = 1000;
  const held = new Set();

  const keyOf = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    const match = /^(?:Digit|Numpad)([1-7])$/.exec(event.code || '')
      || /^([1-7])$/.exec(event.key || '');
    return match ? Number(match[1]) - 1 : null;
  };

  const degreeFromKey = (event) => {
    const target = event.target;
    // Typing into a control means typing, not playing. Only on the way down:
    // see below for why letting go must not ask this question.
    if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return null;
    return keyOf(event);
  };

  document.addEventListener('keydown', event => {
    const degree = degreeFromKey(event);
    if (degree === null) return;
    event.preventDefault();
    // Auto-repeat would retrigger the chord many times a second while held.
    if (event.repeat || held.has(degree)) return;
    held.add(degree);
    onDown(degree, KEYBOARD_POINTER + degree);
  });

  // Whatever is under the pointer when the key comes up, and wherever the focus
  // has got to in the meantime. Asking the same question here as on the way down
  // stranded a note every time: press a key, click a slider, and the click moves
  // the focus onto the slider, so the keyup arrives at an input and was read as
  // typing. The note was then held for ever, with no way to stop it but to press
  // the key again.
  document.addEventListener('keyup', event => {
    const degree = keyOf(event);
    if (degree === null || !held.has(degree)) return;
    held.delete(degree);
    onUp(degree, KEYBOARD_POINTER + degree);
  });

  // Releases everything if the window loses focus mid press, since no keyup
  // arrives for a key that was down when the tab went away.
  window.addEventListener('blur', () => {
    for (const degree of held) onUp(degree, KEYBOARD_POINTER + degree);
    held.clear();
  });

  // Listened on the document rather than per key: a touch pointer is implicitly
  // captured by the key it started on, and some browsers retarget or cancel it
  // mid gesture, so the only reliable question is where the finger is now.
  document.addEventListener('pointermove', e => {
    // Only for a pointer that is holding a key. Working out what is under a
    // pointer is a hit test, and one on every mouse move is layout work on the
    // same thread the audio is scheduled from.
    if (!isHolding(e.pointerId)) return;
    const under = degreeUnder(e.clientX, e.clientY);
    if (under !== null) onSlide(under, e.pointerId);
  }, { passive: true });

  // A finger can leave the page, be cancelled by the browser, or come up over
  // something else entirely. Any of those used to strand a note sounding with
  // no way to stop it, so the release is caught at the document too.
  for (const type of ['pointerup', 'pointercancel']) {
    document.addEventListener(type, e => onUp(null, e.pointerId), { capture: true });
  }
  // A finger cannot still be down on a window that has gone away, so whatever
  // it was holding is let go of. A drone, or a chord the hold lock is holding,
  // is meant to outlive the hand and is left alone.
  window.addEventListener('blur', () => onLeave());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onLeave();
  });

  return {
    update(state) {
      const mods = new Set(state.mods);
      const drums = state.mode === 'drums';
      for (const [degreeIndex, el] of keys) {
        const per = (state.perKey && state.perKey[degreeIndex]) || {};
        // A locked key ignores the modifier pad, so its label has to as well.
        const keyMods = per.lock ? new Set(per.lock) : mods;
        el.classList.toggle('locked', Boolean(per.lock));
        // Writing a label that has not changed still costs a style recalculation,
        // and this runs on every press and release.
        const numeral = drums ? '' : numeralFor(degreeIndex, state.scale);
        const name = drums
          ? DRUM_MAP[degreeIndex % DRUM_MAP.length]
          : chordName(state.keyRoot, degreeIndex, keyMods, state.scale);
        const rn = el.querySelector('.rn');
        const nm = el.querySelector('.nm');
        if (rn.textContent !== numeral) rn.textContent = numeral;
        if (nm.textContent !== name) nm.textContent = name;
        el.classList.toggle('held', state.held.includes(degreeIndex));
      }
    },
  };
}
