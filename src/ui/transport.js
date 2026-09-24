// Where the transport has got to: a row of lamps with the playing one lit, and
// four more for which bar of the phrase it is.
//
// Which is what a groovebox does, and what anybody who has used one will read
// without being told. It was a pair of rings first, on the grounds that a row
// wants width and a phone held upright has none going spare. It does fit, and
// a shape somebody already knows beats a clever one they have to learn.
//
// The maths is kept apart from the drawing, because which lamp is lit at a
// given step is the part worth being sure about.

export const BEATS_PER_BAR = 4;
export const BARS_PER_PHRASE = 4;
const STEPS_PER_BEAT = 4;

// Which beat of the bar, and which bar of the phrase, a step falls on. Counted
// from zero here and shown from one, the way a musician counts them.
export function positionAt(step) {
  const beats = Math.floor(step / STEPS_PER_BEAT);
  return {
    beat: ((beats % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR,
    bar: ((Math.floor(beats / BEATS_PER_BAR) % BARS_PER_PHRASE) + BARS_PER_PHRASE) % BARS_PER_PHRASE,
  };
}

// Whether a step is worth redrawing for: only the ones that land on a beat.
export function isBeat(step) {
  return step % STEPS_PER_BEAT === 0;
}

export const STEPS_PER_BAR = BEATS_PER_BAR * STEPS_PER_BEAT;

// Which lamp of the bar a step falls on, counted from zero.
export function lampAt(step) {
  return ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
}

// The ones that fall on a beat, which are drawn a little stronger so the bar
// can be read at a glance rather than counted.
export function isDownbeatLamp(index) {
  return index % STEPS_PER_BEAT === 0;
}

export function createTransportDial() {
  // A control as well as a display: tapping it stops the transport, or starts
  // it with nothing else going on, since watching the beat go round is a reason
  // on its own. A button rather than a div, so it can be reached by keyboard
  // and says what it is to anything reading the page out.
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'steps tappable';
  el.dataset.ref = 'dial';

  const row = document.createElement('div');
  row.className = 'steprow';
  const lamps = Array.from({ length: STEPS_PER_BAR }, (_, i) => {
    const lamp = document.createElement('i');
    lamp.className = isDownbeatLamp(i) ? 'lamp onbeat' : 'lamp';
    lamp.setAttribute('data-dial-step', String(i));
    row.appendChild(lamp);
    return lamp;
  });

  const barRow = document.createElement('div');
  barRow.className = 'barrow';
  const bars = Array.from({ length: BARS_PER_PHRASE }, (_, i) => {
    const mark = document.createElement('i');
    mark.className = 'barlamp';
    mark.setAttribute('data-dial-bar', String(i));
    barRow.appendChild(mark);
    return mark;
  });

  el.append(row, barRow);
  let shown = null;

  return {
    el,
    // Nothing is playing, so nothing is lit: a playhead stopped part way along
    // looks like a transport that is still running.
    idle() {
      if (shown === null) return;
      shown = null;
      for (const lamp of [...lamps, ...bars]) lamp.classList.remove('now', 'past');
      el.classList.remove('running');
    },
    at(step) {
      const index = lampAt(step);
      const { bar } = positionAt(step);
      if (shown && shown.index === index && shown.bar === bar) return;
      shown = { index, bar };
      el.classList.add('running');
      lamps.forEach((lamp, i) => {
        lamp.classList.toggle('now', i === index);
        lamp.classList.toggle('past', i < index);
      });
      bars.forEach((mark, i) => {
        mark.classList.toggle('now', i === bar);
        mark.classList.toggle('past', i < bar);
      });
    },
    // Why it is running at all, said in words rather than left to be guessed,
    // and what tapping it would do about that.
    because(reason) {
      el.title = reason ? `running: ${reason}. tap to stop` : 'stopped. tap to watch the beat';
      el.setAttribute('aria-label', el.title);
    },
    showing() { return shown ? { ...shown } : null; },
  };
}
