import { chordName, noteNamesOf } from '../theory.js';

export function renderReadout(refs) {
  return {
    update(state) {
      const mods = new Set(state.mods);

      let name = '';
      let notes = 'press a key';

      if (state.held.length > 0) {
        const [first, ...rest] = state.held;
        const also = rest.map(d => chordName(state.keyRoot, d, mods, state.scale)).join(' ');
        name = chordName(state.keyRoot, first, mods, state.scale) + (also ? ` + ${also}` : '');
        notes = noteNamesOf(state.keyRoot, first, mods, state.scale).join(' · ');
      }

      // Only touch the DOM when something actually differs: this runs on every
      // press and release, and needless writes cost layout at the worst moment.
      refs.chordname.classList.toggle('idle', state.held.length === 0);
      if (refs.chordname.textContent !== name) refs.chordname.textContent = name;
      if (refs.notes.textContent !== notes) refs.notes.textContent = notes;

    },
  };
}
