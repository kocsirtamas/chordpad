// The sample library: fetches and decodes the audio a sampled instrument needs,
// once, and hands back the nearest recording to the note being played.
//
// Nothing here blocks playing. An instrument whose samples have not arrived
// yet is played on its fallback synth voice, and swaps over the moment they do,
// so choosing a sound never leaves the pad silent.

export const SAMPLE_PATH = 'samples/';

// The recording nearest the note wanted, so a sample is pitched as little as
// possible: past a few semitones a shifted sample stops sounding like the
// instrument it came from.
export function nearest(samples, semitone) {
  let best = null;
  for (const sample of samples) {
    const distance = Math.abs(sample.note - semitone);
    if (!best || distance < best.distance) best = { sample, distance };
  }
  return best ? best.sample : null;
}

export function createSampleLibrary({ fetcher = globalThis.fetch, path = SAMPLE_PATH } = {}) {
  // file name -> { buffer } once decoded, or a promise while it is on its way.
  const decoded = new Map();
  // Instrument id -> a buffer recorded in this session.
  const recorded = new Map();
  const pending = new Map();
  const failed = new Set();
  const listeners = new Set();

  function announce(id) {
    for (const fn of listeners) {
      try { fn(id); } catch (err) { console.error(err); }
    }
  }

  async function fetchOne(ctx, file) {
    const response = await fetcher(path + file);
    if (!response || !response.ok) throw new Error(`sample ${file} is not there`);
    const bytes = await response.arrayBuffer();
    return await ctx.decodeAudioData(bytes);
  }

  return {
    onReady(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // True once every sample the instrument needs has been decoded.
    isReady(preset) {
      if (!preset) return false;
      // An instrument that is recorded into has no files to wait for: it is
      // ready when something has been recorded and not before. Asking whether
      // every one of no files has arrived answers yes, which it is not.
      if (preset.recorded) return recorded.has(preset.id);
      if (!preset.samples || preset.samples.length === 0) return false;
      return preset.samples.every(sample => decoded.has(sample.file));
    },

    isLoading(preset) {
      if (!preset || preset.recorded || !preset.samples) return false;
      return preset.samples.some(sample => pending.has(sample.file));
    },

    // Asked for whenever a sampled instrument is chosen. Safe to call again:
    // each file is fetched once, and one that failed is not retried on every
    // key press.
    load(ctx, preset) {
      if (!ctx || !preset || !preset.samples) return Promise.resolve(false);
      const waits = preset.samples.map((sample) => {
        if (decoded.has(sample.file)) return Promise.resolve(true);
        if (failed.has(sample.file)) return Promise.resolve(false);
        if (pending.has(sample.file)) return pending.get(sample.file);

        const wait = fetchOne(ctx, sample.file)
          .then((buffer) => {
            decoded.set(sample.file, buffer);
            pending.delete(sample.file);
            return true;
          })
          .catch((err) => {
            // One missing file must not take the instrument down: it falls back
            // to its synth voice and says so once in the console.
            console.warn(`chordpad: ${sample.file} could not be loaded`, err);
            failed.add(sample.file);
            pending.delete(sample.file);
            return false;
          });
        pending.set(sample.file, wait);
        return wait;
      });

      return Promise.all(waits).then((results) => {
        const ready = results.every(Boolean);
        if (ready) announce(preset.id);
        return ready;
      });
    },

      // A sample recorded here rather than fetched: the microphone's. Held by
    // instrument id, in memory only, since a few seconds of audio has no
    // business in the preset store.
    put(id, buffer, semitone) {
      recorded.set(id, { buffer, baseSemitone: semitone });
      announce(id);
    },

    forget(id) { recorded.delete(id); },
    has(id) { return recorded.has(id); },

  // The buffer to play this note with, or null if the instrument is not ready.
    bufferFor(preset, semitone) {
      if (!preset) return null;
      const own = recorded.get(preset.id);
      if (own) return own;
      if (!preset.samples) return null;
      const sample = nearest(preset.samples, semitone);
      if (!sample) return null;
      const buffer = decoded.get(sample.file);
      return buffer ? { buffer, baseSemitone: sample.note } : null;
    },
  };
}
