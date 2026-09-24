import { group, option, slider, toLoopSwitch, updateToLoop, toSampleSwitch, updateToSample }
  from '../controls.js';

import { INSTRUMENTS, SYNTH_IDS, SAMPLED_IDS, RECORDED_IDS } from '../../audio/instruments.js';
import { DELAY_TIMES, TREMOLO_RATES, VIBRATO_DEPTHS, REVERB_SECONDS } from '../../audio/effects.js';
import { ENVELOPE_IDS } from '../../audio/envelope.js';
import { CATEGORY_IDS } from '../../loopfx.js';

// Only the effects carry a switch for the samples: an instrument or a filter is
// how the hands sound, and a recorded sample is a recording rather than
// something being played now.
const SAMPLE_EFFECTS = new Set(['reverb', 'chorus', 'flanger', 'delay', 'tremolo', 'vibrato']);

export function soundPanel(state, { instrumentStatus = () => 'ready' } = {}) {
  const el = document.createElement('div');
  el.className = 'panelbody';

  function instruments(label, ids) {
    const g = group(label);
    ids.forEach(id => {
      g.row.appendChild(option(INSTRUMENTS[id].label, () => state.set({ instrument: id }), b => {
        b.dataset.instrument = id;
      }));
    });
    // Both lists choose the same setting, so both carry the same switch.
    toLoop(g.row, 'instrument');
    return g;
  }

  const sounds = instruments('SOUND', SYNTH_IDS);
  // Recordings of real instruments. They arrive when they are first chosen, and
  // until they do the button says so and the fallback synth voice plays.
  // The microphone's own sample has its own panel, where it is recorded.
  const sampled = instruments('SAMPLED', SAMPLED_IDS.filter(id => !RECORDED_IDS.includes(id)));

  // An effect category can be let through to a loop that is already recorded, or
  // kept off it, and the switch belongs with the category it decides for.
  function toLoop(row, id) {
    if (!CATEGORY_IDS.includes(id)) return;
    row.appendChild(toLoopSwitch(state, id));
    if (SAMPLE_EFFECTS.has(id)) row.appendChild(toSampleSwitch(state, id));
  }

  // An on/off effect, with its own switch for whether the loop hears it.
  const toggleButtons = [];
  function switchGroup(label, key) {
    const g = group(label);
    const b = option(key, () => state.set({ [key]: !state.get()[key] }),
      button => { button.dataset.toggle = key; });
    g.row.appendChild(b);
    toggleButtons.push(b);
    toLoop(g.row, key);
    return g;
  }

  // The rest are one-of-several: same control, different list.
  function choices(label, key, ids) {
    const g = group(label);
    ids.forEach(id => {
      g.row.appendChild(option(String(id), () => state.set({ [key]: id }),
        b => { b.dataset[key] = String(id); }));
    });
    toLoop(g.row, key);
    return { ...g, key };
  }

  // Two different things, which is why there are two: how much of the room is
  // heard, and how long it rings for.
  const reverbMix = slider('REVERB MIX', 0, 100, 5, '%',
    v => state.set({ reverbMix: v / 100 }));
  const reverbTime = slider('REVERB TIME', REVERB_SECONDS.min, REVERB_SECONDS.max, REVERB_SECONDS.step, ' s',
    v => state.set({ reverbTime: v }));

  const reverb = switchGroup('REVERB', 'reverb');
  const chorus = switchGroup('CHORUS', 'chorus');
  const flanger = switchGroup('FLANGER', 'flanger');
  // Stereo is a property of the voice rather than the rack, so a loop keeps or
  // follows it with the rest of its sound, from the mixer's own switch.
  const stereo = switchGroup('STEREO', 'stereo');

  const delay = choices('DELAY', 'delay', DELAY_TIMES);

  const lists = [
    delay,
    choices('TREMOLO', 'tremolo', TREMOLO_RATES),
    choices('VIBRATO', 'vibrato', VIBRATO_DEPTHS),
    choices('GLIDE', 'glide', ['off', 'slow', 'fast']),
    choices('VOICES', 'voices', [8, 4, 2, 1]),
    choices('ADSR', 'adsr', ENVELOPE_IDS),
  ];
  const sustain = slider('SUSTAIN', 0.05, 12, 0.05, 's', v => state.set({ sustain: v }));
  const tone = slider('TONE', 40, 18000, 20, 'Hz', v => state.set({ cutoff: v }));
  tone.el.appendChild(toLoopSwitch(state, 'cutoff'));

  el.append(sounds.el, sampled.el, reverb.el, reverbMix.el, reverbTime.el, chorus.el, flanger.el, stereo.el,
    ...lists.map(l => l.el), sustain.el, tone.el);

  return {
    el,
    update(next) {
      for (const b of sounds.row.children) {
        if (b.dataset.toloop) continue;
        b.classList.toggle('on', b.dataset.instrument === next.instrument);
      }
      for (const b of sampled.row.children) {
        if (b.dataset.toloop) continue;
        const id = b.dataset.instrument;
        b.classList.toggle('on', id === next.instrument);
        const status = instrumentStatus(id);
        b.classList.toggle('loading', status === 'loading');
        b.classList.toggle('off', status === 'missing' && id === next.instrument);
        const label = INSTRUMENTS[id].label + (status === 'loading' ? ' …' : '');
        if (b.textContent !== label) b.textContent = label;
      }
      for (const b of toggleButtons) b.classList.toggle('on', Boolean(next[b.dataset.toggle]));
      for (const list of lists) {
        for (const b of list.row.children) {
          // The to loop switch shares the row but is not one of the choices, and
          // this loop used to clear the highlight it had just been given.
          if (b.dataset.toloop) continue;
          b.classList.toggle('on', b.dataset[list.key] === String(next[list.key]));
        }
      }
      reverbMix.set(Math.round((next.reverbMix === undefined ? 0.35 : next.reverbMix) * 100));
      reverbTime.set(next.reverbTime === undefined ? REVERB_SECONDS.default : Math.round(next.reverbTime * 4) / 4);
      // Last, so nothing else can clear a switch it has just set.
      updateToLoop(el, next);
      updateToSample(el, next);
      sustain.set(next.sustain);
      tone.set(next.cutoff);
    },
  };
}
