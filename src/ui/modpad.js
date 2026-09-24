// Nine cells laid out like the joystick: the device's eight directions around a
// centre that switches between the three modifier layers.

import { layerFor } from '../layers.js';

// Where the centre sits, so the eight cells fall around it.
const CENTRE = 4;

export function renderModpad(refs, { onPress, onRelease, onLayer }) {
  const cells = [];
  let showing = null;

  for (let position = 0; position < 9; position++) {
    const el = document.createElement('div');
    el.className = 'mod';

    if (position === CENTRE) {
      el.classList.add('centre');
      el.addEventListener('pointerdown', () => onLayer());
    } else {
      // What was pressed is remembered on the way down, not read back on the
      // way up: a layer can change under a finger that is still holding a cell,
      // and releasing whatever the cell says by then leaves the thing actually
      // being held latched for ever, with nothing on screen to let go of it.
      const holding = new Map();
      el.addEventListener('pointerdown', e => {
        holding.set(e.pointerId, el.dataset.cell);
        onPress(el.dataset.cell);
        try { el.setPointerCapture(e.pointerId); } catch { /* no active pointer */ }
      });
      const up = (e) => {
        const pressed = holding.get(e.pointerId);
        holding.delete(e.pointerId);
        onRelease(pressed === undefined ? el.dataset.cell : pressed);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      cells.push(el);
    }

    refs.modpad.appendChild(el);
  }

  const centre = refs.modpad.children[CENTRE];

  return {
    update(state) {
      const layer = layerFor(state.modLayer);
      if (layer.id !== showing) {
        showing = layer.id;
        centre.innerHTML = `<b>${layer.label}</b><span class="sub">layer</span>`;
        cells.forEach((el, i) => {
          el.dataset.cell = layer.cells[i].id;
          el.innerHTML = layer.cells[i].label;
        });
      }
      for (const el of cells) {
        // classList.toggle with an unchanged value does not mutate anything, so
        // this is already free.
        el.classList.toggle('latched', state.latched.includes(el.dataset.cell));
        el.classList.toggle('momentary', state.momentary.includes(el.dataset.cell));
      }
      // A cell latched on another layer is still applying, so the switch says so.
      const elsewhere = [...state.latched, ...state.momentary]
        .filter(id => !layer.cells.some(cell => cell.id === id));
      centre.classList.toggle('latched', elsewhere.length > 0);
    },
  };
}
