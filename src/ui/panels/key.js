import { group, option, onHold, toLoopSwitch, updateToLoop } from '../controls.js';
import { NOTE_NAMES, SCALES, SCALE_IDS } from '../../theory.js';
import { createPresets, snapshot } from '../../presets.js';
import { saveFile, readFile, stamp } from '../../download.js';

export function keyPanel(state) {
  const el = document.createElement('div');
  el.className = 'panelbody';
  const presets = createPresets({});

  const keys = group('KEY');
  NOTE_NAMES.forEach((name, root) => {
    keys.row.appendChild(option(name, () => state.set({ keyRoot: root }), b => {
      b.dataset.keyRoot = String(root);
    }));
  });

  keys.row.appendChild(toLoopSwitch(state, 'keyRoot'));

  const scales = group('SCALE');
  SCALE_IDS.forEach(id => {
    scales.row.appendChild(option(SCALES[id].name, () => state.set({ scale: id }), b => {
      b.dataset.scale = id;
    }));
  });

  scales.row.appendChild(toLoopSwitch(state, 'scale'));

  const octave = group('OCTAVE');
  [2, 3, 4, 5, 6].forEach(value => {
    octave.row.appendChild(option(String(value), () => state.set({ baseOctave: value }), b => {
      b.dataset.octave = String(value);
    }));
  });

  octave.row.appendChild(toLoopSwitch(state, 'baseOctave'));

  const inversion = group('INVERSION');
  ['root', '1st', '2nd'].forEach((label, index) => {
    inversion.row.appendChild(option(label, () => state.set({ inversion: index }), b => {
      b.dataset.inversion = String(index);
    }));
  });

  inversion.row.appendChild(toLoopSwitch(state, 'inversion'));

  const voicing = group('VOICING');
  const lead = option('voice lead', () => state.set({ voiceLeading: !state.get().voiceLeading }));
  lead.dataset.voiceLeading = 'on';
  const bassOff = option('bass off', () => state.set({ bass: 'off' }), b => { b.dataset.bass = 'off'; });
  const bassRoot = option('bass root', () => state.set({ bass: 'root' }), b => { b.dataset.bass = 'root'; });
  voicing.row.append(lead, bassOff, bassRoot);

  voicing.row.appendChild(toLoopSwitch(state, 'voiceLeading', 'lead to loop'));
  voicing.row.appendChild(toLoopSwitch(state, 'bass', 'bass to loop'));

  const perKey = group('PER KEY');
  const pick = document.createElement('div');
  pick.className = 'optrow';
  for (let degree = 0; degree < 7; degree++) {
    pick.appendChild(option(String(degree + 1), () => state.set({ editingKey: degree }), b => {
      b.dataset.editKey = String(degree);
    }));
  }
  const octaveDown = option('oct -', () => shiftKeyOctave(state, -1));
  const octaveUp = option('oct +', () => shiftKeyOctave(state, 1));
  const lockButton = option('lock', () => toggleKeyLock(state));
  perKey.row.append(pick, octaveDown, octaveUp, lockButton);

  const saved = group('PRESETS');

  // A preset lives in this browser by default. A file is the way to keep one
  // past a cleared cache, or to put it on another device.
  // What the button will write, which is the only honest way to label it: the
  // loaded preset, or all of the saved ones, or, when nothing is saved at all,
  // the settings in force right now. Writing an empty list was the old
  // behaviour and it was simply a file with nothing in it.
  function fileToWrite() {
    const s = state.get();
    const saved = presets.list();
    const active = s.activePreset === null || s.activePreset === undefined ? null : s.activePreset;
    if (active !== null && saved[active]) {
      return { label: `to file · ${saved[active].name}`, json: presets.exportOne(active),
        name: `chordpad-preset-${saved[active].name}.json` };
    }
    if (saved.length > 0) {
      return { label: 'to file · all', json: presets.export(),
        name: `chordpad-presets-${stamp()}.json` };
    }
    return { label: 'to file · now', json: JSON.stringify([{ name: 'now', values: snapshot(s) }], null, 2),
      name: `chordpad-preset-${stamp()}.json` };
  }

  const toFile = option('to file', () => {
    const file = fileToWrite();
    if (!file.json) return;
    saveFile(file.name, new Blob([file.json], { type: 'application/json' }));
  });

  // Saving or importing a preset changes what the button would write, and
  // neither of those is a state change, so the label is refreshed here too.
  function refreshFileButton() {
    const label = fileToWrite().label;
    if (toFile.textContent !== label) toFile.textContent = label;
  }
  toFile.dataset.presetFile = 'save';

  // A real input rather than one conjured up on the click: it is the same file
  // picker either way, and this one can be found, styled and tested.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'application/json,.json';
  picker.className = 'filepicker';
  picker.dataset.presetFile = 'load';
  picker.addEventListener('change', async () => {
    const text = await readFile(picker);
    picker.value = '';
    if (!text) return;
    // Added to what is already saved rather than replacing it.
    presets.merge(text);
    renderPresets();
  });

  const fromFile = option('from file', () => picker.click());

  function renderPresets() {
    saved.row.innerHTML = '';
    saved.row.appendChild(option('+ save', () => {
      // What was just saved is what is loaded, so it lights up and the file
      // button offers that one preset rather than the whole list.
      const index = presets.save(state.get());
      state.set({ activePreset: index });
      renderPresets();
    }));
    saved.row.append(toFile, fromFile, picker);
    refreshFileButton();
    for (const entry of presets.list()) {
      const b = option(entry.name, () => {
        state.set({ ...(presets.load(entry.index) || {}), activePreset: entry.index });
      });
      b.dataset.preset = String(entry.index);
      // Held rather than double tapped: a double tap is unreliable when another
      // finger is already on the pad.
      onHold(b, () => {
        presets.remove(entry.index);
        renderPresets();
      });
      b.title = 'tap to load, hold to delete';
      saved.row.appendChild(b);
    }
  }
  renderPresets();

  el.append(keys.el, scales.el, octave.el, inversion.el, voicing.el, perKey.el, saved.el);

  return {
    el,
    update(next) {
      for (const b of keys.row.children) b.classList.toggle('on', Number(b.dataset.keyRoot) === next.keyRoot);
      for (const b of scales.row.children) b.classList.toggle('on', b.dataset.scale === next.scale);
      for (const b of octave.row.children) b.classList.toggle('on', Number(b.dataset.octave) === next.baseOctave);
      for (const b of inversion.row.children) b.classList.toggle('on', Number(b.dataset.inversion) === next.inversion);
      const editing = next.editingKey || 0;
      for (const b of pick.children) {
        b.classList.toggle('on', Number(b.dataset.editKey) === editing);
      }
      refreshFileButton();
      // Last, so nothing else can clear a switch it has just set.
      updateToLoop(el, next);
      const per = (next.perKey && next.perKey[editing]) || { octave: 0, lock: null };
      lockButton.textContent = per.lock ? `locked: ${per.lock.join(' ') || 'plain'}` : 'lock';
      lockButton.classList.toggle('on', Boolean(per.lock));
      octaveDown.textContent = per.octave ? `oct ${per.octave > 0 ? '+' : ''}${per.octave}` : 'oct -';

      for (const b of saved.row.children) {
        if (b.dataset.preset === undefined) continue;
        b.classList.toggle('on', Number(b.dataset.preset) === next.activePreset);
      }
      lead.classList.toggle('on', next.voiceLeading);
      bassOff.classList.toggle('on', next.bass === 'off');
      bassRoot.classList.toggle('on', next.bass === 'root');
    },
  };
}

// A key's own octave, clamped to the range the device allows.
function shiftKeyOctave(state, by) {
  const s = state.get();
  const index = s.editingKey || 0;
  const perKey = s.perKey.map(entry => ({ ...entry }));
  perKey[index].octave = Math.max(-2, Math.min(1, (perKey[index].octave || 0) + by));
  state.set({ perKey });
}

// Locks whatever the modifier pad is showing onto this key, so it keeps playing
// that chord whatever the pad says later. Locking again clears it.
function toggleKeyLock(state) {
  const s = state.get();
  const index = s.editingKey || 0;
  const perKey = s.perKey.map(entry => ({ ...entry }));
  perKey[index].lock = perKey[index].lock
    ? null
    : [...(s.mods || [])];
  state.set({ perKey });
}
