// Presets, stored in localStorage. The device has four slots because of its
// flash; there is no such limit here, so the list is unbounded and every entry
// keeps the whole playable state.

const STORAGE_KEY = 'chordpad.presets.v1';

// What a preset remembers. Anything transient, such as which keys are held or
// what the looper is doing, is deliberately left out.
export const PERSISTED_KEYS = [
  'keyRoot', 'scale', 'baseOctave', 'mode', 'bpm', 'instrument',
  'sustain', 'cutoff', 'volume', 'arpPattern', 'arpRate', 'arpChord', 'strumSpeed',
  'reverb', 'reverbMix', 'reverbTime', 'chorus', 'flanger', 'stereo', 'delay', 'tremolo',
  'vibrato', 'glide', 'voices', 'adsr',
  'inversion', 'voiceLeading', 'bass', 'kit', 'beat', 'beatVariation', 'autoDrum', 'metronome', 'countIn', 'autoBounce',
  'samplerSource', 'samplerBars', 'samplerRaw', 'samplerLoop', 'sampleSpeed', 'samplePitch', 'sampleTape', 'sampleTone',
  'vocoder', 'vocoderSamples', 'vocoderFormant', 'vocoderQ', 'vocoderAttack', 'vocoderRelease', 'vocoderNoise', 'vocoderGate',
  'modLayer', 'perKey', 'toLoop', 'toSample', 'onTheBeat',
];

export function snapshot(state) {
  const out = {};
  for (const key of PERSISTED_KEYS) {
    if (state[key] !== undefined) out[key] = state[key];
  }
  return out;
}

// A stored preset is only trusted for the keys we know about, so a hand edited
// or outdated entry cannot inject anything unexpected into state. Now that
// presets travel as files, this is the only place that has to be careful.
export function sanitise(preset) {
  const out = snapshot(preset || {});
  if (out.perKey !== undefined) {
    const given = Array.isArray(out.perKey) ? out.perKey : [];
    out.perKey = Array.from({ length: 7 }, (_, i) => ({
      octave: Number((given[i] || {}).octave) || 0,
      lock: Array.isArray((given[i] || {}).lock) ? given[i].lock.map(String) : null,
    }));
  }
  return out;
}

export function createPresets({ storage = globalThis.localStorage } = {}) {
  function readAll() {
    if (!storage) return [];
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAll(list) {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      // A full or blocked store is not worth breaking the instrument over.
    }
  }

  return {
    list() {
      return readAll().map((entry, index) => ({ name: entry.name || `P${index + 1}`, index }));
    },
    save(state, name) {
      const list = readAll();
      list.push({ name: name || `P${list.length + 1}`, values: snapshot(state) });
      writeAll(list);
      return list.length - 1;
    },
    load(index) {
      const entry = readAll()[index];
      return entry ? sanitise(entry.values) : null;
    },
    remove(index) {
      const list = readAll();
      if (index < 0 || index >= list.length) return false;
      list.splice(index, 1);
      writeAll(list);
      return true;
    },
    clear() {
      writeAll([]);
    },
    export() {
      return JSON.stringify(readAll(), null, 2);
    },

    // One preset on its own, so a sound can be sent to somebody without sending
    // everything else along with it.
    exportOne(index) {
      const entry = readAll()[index];
      return entry ? JSON.stringify([{ name: entry.name, values: sanitise(entry.values) }], null, 2) : null;
    },

    // Presets from a file are added to what is already there. Replacing the lot
    // would throw away work that was never asked to be thrown away.
    merge(json) {
      try {
        const parsed = JSON.parse(json);
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        const list = readAll();
        for (const entry of incoming) {
          if (!entry || typeof entry !== 'object') continue;
          const values = sanitise(entry.values || entry);
          if (Object.keys(values).length === 0) continue;
          list.push({ name: String(entry.name || `P${list.length + 1}`).slice(0, 24), values });
        }
        writeAll(list);
        return list.length;
      } catch {
        return 0;
      }
    },
    import(json) {
      try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return false;
        writeAll(parsed.map((entry, i) => ({
          name: entry.name || `P${i + 1}`,
          values: sanitise(entry.values),
        })));
        return true;
      } catch {
        return false;
      }
    },
  };
}
