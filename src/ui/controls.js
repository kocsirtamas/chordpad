// Shared panel controls. All three panels used to carry their own copies of
// these, which meant fixing anything three times.
//
// Everything binds to pointerdown rather than click. A tap made while another
// finger is already down often never becomes a click at all, so click-driven
// controls simply ignore the second thumb, which makes it impossible to change
// a setting without releasing the chord first.

// Fires on release, but only if the finger stayed put: a drag is a scroll, not
// a tap. Deliberately not the click event, because a tap made while another
// finger is already down often never becomes one, and deliberately without
// preventDefault, because that would stop a panel from scrolling.
const TAP_SLOP = 12;
const TAP_MS = 800;

export function onTap(el, handler) {
  let start = null;
  el.addEventListener('pointerdown', event => {
    start = { x: event.clientX, y: event.clientY, at: Date.now(), id: event.pointerId };
  });
  el.addEventListener('pointercancel', () => { start = null; });
  el.addEventListener('pointerup', event => {
    if (!start || start.id !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    const held = Date.now() - start.at;
    start = null;
    if (moved <= TAP_SLOP && held <= TAP_MS) handler(event);
  });
}

// A press held past the threshold, used where a second action is needed on the
// same control and a double tap would be unreliable with other fingers down.
export function onHold(el, handler, ms = 550) {
  let timer = null;
  const cancel = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  el.addEventListener('pointerdown', () => {
    cancel();
    timer = setTimeout(() => { timer = null; handler(); }, ms);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    el.addEventListener(type, cancel);
  }
}

// Chrome decides what gesture a touch sequence is allowed to be from its FIRST
// touch point. A held chord key has touch-action none, so while one is down the
// browser refuses to pan anything, including a panel that is plainly scrollable.
// The only way to scroll with the other thumb is to do it ourselves.
export function enableDragScroll(el) {
  let drag = null;

  el.addEventListener('pointerdown', event => {
    drag = { id: event.pointerId, y: event.clientY, top: el.scrollTop, scrolling: false };
  });

  document.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dy = event.clientY - drag.y;
    // A few pixels of slop, so a tap that wobbles is still a tap.
    if (!drag.scrolling && Math.abs(dy) < 4) return;
    drag.scrolling = true;
    el.scrollTop = drag.top - dy;
  });

  for (const type of ['pointerup', 'pointercancel']) {
    document.addEventListener(type, event => {
      if (drag && event.pointerId === drag.id) drag = null;
    });
  }
}

export function group(label) {
  const el = document.createElement('div');
  el.className = 'group';
  const head = document.createElement('div');
  head.className = 'grouplabel';
  head.textContent = label;
  const row = document.createElement('div');
  row.className = 'optrow';
  el.append(head, row);
  return { el, row };
}

export function option(text, handler, decorate) {
  const b = document.createElement('button');
  b.className = 'opt';
  b.textContent = text;
  onTap(b, handler);
  if (decorate) decorate(b);
  return b;
}

export function slider(label, min, max, step, unit, onInput, { reset = null } = {}) {
  const el = document.createElement('div');
  el.className = 'cell wide';
  const head = document.createElement('span');
  head.className = 'lbl';
  const value = document.createElement('b');
  head.append(label + ' ', value);
  // Somewhere to put a value back where it was. On the reading rather than as
  // another button in the row, since it belongs to this slider and nothing
  // else, and a row of controls with a reset between each of them is a row
  // nobody can read.
  if (reset !== null) {
    const back = document.createElement('button');
    back.className = 'reset';
    back.type = 'button';
    back.textContent = 'reset';
    back.dataset.reset = label.toLowerCase().replace(/[^a-z]+/g, '-');
    back.title = `back to ${reset}${unit}`;
    onTap(back, () => onInput(reset));
    head.append(' ', back);
  }
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step });
  input.addEventListener('input', () => onInput(parseFloat(input.value)));
  el.append(head, input);
  return {
    el,
    set(v) { input.value = String(v); value.textContent = `${v}${unit}`; },
  };
}


// The switch that says whether a setting reaches a loop that is already
// recorded. Lives next to the setting it decides for, in whichever panel that
// is, so there is one of these rather than one per panel.
export function toLoopSwitch(state, id, label = 'to loop') {
  const b = option(label, () => {
    // With nothing recorded there is no loop for a setting to reach, so the
    // switch has nothing to say either way: it reads as a decision that has
    // been made when it is only a decision that has not come up yet.
    if (!hasLoop(state.get())) return;
    const current = state.get().toLoop || {};
    state.set({ toLoop: { ...current, [id]: !current[id] } });
  }, button => { button.dataset.toloop = id; });
  return b;
}

function hasLoop(state) {
  return Boolean(state.looper && state.looper.tracks > 0);
}

// Whether an effect reaches the recorded samples. On to begin with, since that
// is what a sample got when it shared a rack with the hands, and a setting
// quietly doing less than it used to is worse than one doing more.
export function toSampleSwitch(state, id, label = 'to samples') {
  return option(label, () => {
    const current = state.get().toSample || {};
    state.set({ toSample: { ...current, [id]: current[id] === false } });
  }, button => { button.dataset.tosample = id; });
}

export function updateToSample(root, state) {
  const allow = state.toSample || {};
  const samples = (state.sampleCount || 0) > 0;
  for (const b of root.querySelectorAll('[data-tosample]')) {
    b.classList.toggle('on', allow[b.dataset.tosample] !== false);
    b.classList.toggle('idle', !samples);
    b.title = samples
      ? 'whether this reaches the recorded samples as well as the hands'
      : 'nothing recorded yet, so there is nothing for this to reach';
  }
}

// Applied by each panel after its own highlighting, so nothing clears it.
export function updateToLoop(root, state) {
  const follows = state.toLoop || {};
  const recorded = hasLoop(state);
  for (const b of root.querySelectorAll('[data-toloop]')) {
    b.classList.toggle('on', recorded && Boolean(follows[b.dataset.toloop]));
    b.classList.toggle('idle', !recorded);
    b.title = recorded
      ? 'off: a recorded loop keeps what it was recorded with'
      : 'nothing recorded yet, so there is no loop for this to reach';
  }
}
