// The three modifier layers. The device stacks them on one joystick; here the
// same nine cells change what they mean, so twenty four chord shapes are
// reachable with one thumb and no extra screen space.
//
// A cell is a label and the modifiers it applies. Anything the pad, the readout
// or a locked key needs is the expanded modifier set, never the cell id.

// Nine positions, the centre one being the layer switch itself.
export const LAYERS = [
  {
    id: 'base',
    label: 'base',
    cells: [
      { id: 'aug', label: 'aug', mods: ['aug'] },
      { id: 'minmaj', label: 'maj-min', mods: ['minmaj'] },
      { id: 'dom7', label: '7', mods: ['dom7'] },
      { id: 'dim', label: 'dim', mods: ['dim'] },
      { id: 'maj7', label: 'maj7', mods: ['maj7'] },
      { id: 'six', label: '6', mods: ['six'] },
      { id: 'sus4', label: 'sus4', mods: ['sus4'] },
      { id: 'add9', label: '9', mods: ['add9'] },
    ],
  },
  {
    id: 'ext',
    label: 'ext',
    cells: [
      { id: 'ext:m7b5', label: 'm7b5', mods: ['dim', 'dom7'] },
      { id: 'ext:7sus4', label: '7sus4', mods: ['sus4', 'dom7'] },
      { id: 'ext:9', label: '9', mods: ['dom7', 'add9'] },
      { id: 'ext:m9', label: 'm9', mods: ['min', 'dom7', 'add9'] },
      { id: 'ext:7sharp9', label: '7#9', mods: ['dom7', 'sharpNine'] },
      { id: 'ext:m11', label: 'm11', mods: ['min', 'dom7', 'add9', 'eleven'] },
      { id: 'ext:add11', label: 'add11', mods: ['eleven'] },
      { id: 'ext:m6', label: 'm6', mods: ['min', 'six'] },
    ],
  },
  {
    id: 'chromatic',
    label: 'chrom',
    cells: [
      { id: 'chr:dim7', label: 'dim7', mods: ['dim', 'dimSeven'] },
      { id: 'chr:mmaj7', label: 'mMaj7', mods: ['min', 'majSeven'] },
      { id: 'chr:13', label: '13', mods: ['dom7', 'add9', 'thirteen'] },
      { id: 'chr:maj13', label: 'maj13', mods: ['maj', 'majSeven', 'add9', 'thirteen'] },
      { id: 'chr:7b9', label: '7b9', mods: ['dom7', 'flatNine'] },
      { id: 'chr:69', label: '6/9', mods: ['six', 'add9'] },
      { id: 'chr:maj7sharp11', label: 'maj7#11', mods: ['maj', 'majSeven', 'sharpEleven'] },
      { id: 'chr:7alt', label: '7alt', mods: ['dom7', 'flatNine', 'sharpNine', 'flatThirteen'] },
    ],
  },
];

export const LAYER_IDS = LAYERS.map(layer => layer.id);

const CELLS = new Map(LAYERS.flatMap(layer => layer.cells.map(cell => [cell.id, cell])));

export function layerFor(id) {
  return LAYERS.find(layer => layer.id === id) || LAYERS[0];
}

export function nextLayer(id) {
  return LAYER_IDS[(LAYER_IDS.indexOf(id) + 1) % LAYER_IDS.length];
}

// Cell ids in, chord modifiers out. A cell from a layer that is no longer shown
// still applies while it is latched, which is what makes stacking layers useful.
export function expandMods(cellIds) {
  const out = new Set();
  for (const id of cellIds) {
    const cell = CELLS.get(id);
    for (const mod of (cell ? cell.mods : [id])) out.add(mod);
  }
  return out;
}
