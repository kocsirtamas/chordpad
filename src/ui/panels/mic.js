import { group, option, slider, onHold } from '../controls.js';

// Everything that listens rather than plays: the tuner, the sampler and the
// vocoder. One panel, because they all want the same permission and it is
// worth asking for it once, in one place, where a refusal can be explained.

export function micPanel(state, actions = {}) {
  const el = document.createElement('div');
  el.className = 'panelbody';

  // One switch, like everything else here. Two buttons for one piece of state
  // meant one of them was always the wrong one to reach for.
  const access = group('MICROPHONE');
  const enable = option('microphone', () => {
    if (state.get().mic === 'live') {
      if (actions.disableMic) actions.disableMic();
    } else if (actions.enableMic) {
      actions.enableMic();
    }
  });
  enable.dataset.mic = 'enable';
  enable.dataset.toggle = 'mic';
  const micState = document.createElement('div');
  micState.className = 'statusbox empty';
  micState.dataset.ref = 'micState';
  access.row.append(enable, micState);

  const tuner = group('TUNER');
  const tunerToggle = option('tuner', () => state.set({ tuner: !state.get().tuner }),
    b => { b.dataset.toggle = 'tuner'; });
  const reading = document.createElement('div');
  reading.className = 'statusbox empty';
  reading.dataset.ref = 'tuner';
  tuner.row.append(tunerToggle, reading);

  // Hold to record; letting go makes a loop that is already playing. One
  // toggle appears per recording, on to begin with, since the reason to record
  // something is to hear it.
  const sampler = group('SAMPLER');
  const record = option('hold to record', () => {});
  record.dataset.sampler = 'record';
  record.addEventListener('pointerdown', (event) => {
    // Capture keeps the release on this button if the finger slides off it, but
    // it is best effort: never let it stop the recording from starting.
    try { record.setPointerCapture(event.pointerId); } catch { /* no active pointer */ }
    if (actions.startRecording) actions.startRecording();
  });
  const letGo = () => { if (actions.stopRecording) actions.stopRecording(); };
  record.addEventListener('pointerup', letGo);
  record.addEventListener('pointercancel', letGo);
  record.addEventListener('lostpointercapture', letGo);

  // What it listens to. Recording the output is resampling: everything that
  // shapes the sound is already in the recording by then, the vocoder included,
  // which is the one thing recording the microphone can never capture. It also
  // needs no microphone, so no permission either.
  const sources = [['mic', 'from mic'], ['out', 'from output']];
  const sourceButtons = sources.map(([id, label]) => {
    const b = option(label, () => state.set({ samplerSource: id }));
    b.dataset.samplerSource = id;
    b.title = id === 'out'
      ? 'records what you hear, effects and vocoder and all'
      : 'records the microphone on its own';
    return b;
  });

  // How long a take is. Free is however long the button is held; the rest begin
  // on the next downbeat and run for exactly that many bars, so what comes out
  // lines up with the drums and the arpeggiator rather than only with the other
  // samples.
  const lengths = [[0, 'free'], [0.25, '1/4'], [0.5, '2/4'], [1, '1 bar'], [2, '2 bars'], [4, '4 bars']];
  const lengthButtons = lengths.map(([bars, label]) => {
    const b = option(label, () => state.set({ samplerBars: bars }));
    b.dataset.samplerBars = String(bars);
    b.title = bars === 0
      ? 'as long as the button is held'
      : bars < 1
        ? `a ${label} of a bar, so ${Math.round(1 / bars)} of them fill one`
        : `starts on the next downbeat and runs for ${label}`;
    return b;
  });

  const clear = option('clear all', () => actions.clearSamples && actions.clearSamples());
  clear.dataset.sampler = 'clear';
  // One speed for all the loops rather than one each: they scale together and
  // stay in step, where a speed per loop would pull them apart, which is the
  // one thing the locked length is there to prevent.
  const speed = slider('SAMPLE SPEED', 0.1, 4, 0.05, 'x', v => state.set({ sampleSpeed: v }),
    { reset: 1 });
  speed.el.title = 'slower is lower, the way tape is: it carries the pitch with it. '
    + 'past twice, bright material folds back on itself, which is what a sampler does';
  const tape = option('tape', () => state.set({ sampleTape: !state.get().sampleTape }),
    b => { b.dataset.toggle = 'sampleTape'; });
  tape.title = 'speed carries the pitch with it, the way tape does: slower is lower';
  const pitch = slider('SAMPLE PITCH', -24, 24, 1, ' st', v => state.set({ samplePitch: v }),
    { reset: 0 });
  pitch.el.title = 'moves the pitch without moving the speed, so a loop stays the length it is';
  const tone = slider('SAMPLE TONE', 40, 20000, 20, ' Hz', v => state.set({ sampleTone: v }));
  tone.el.title = 'takes the top off the loops, so they sit under what is played live';
  const loops = document.createElement('div');
  loops.className = 'optrow';
  loops.dataset.ref = 'sampleLoops';
  const sampleState = document.createElement('div');
  sampleState.className = 'statusbox empty';
  sampleState.dataset.ref = 'sampler';
  sampler.row.append(record, ...sourceButtons, ...lengthButtons, tape, clear, loops, sampleState);

  // One button per recording, made as they arrive and thrown away with them.
  const buttons = new Map();

  function renderLoops(list) {
    for (const [id, button] of buttons) {
      if (!list.some(sample => sample.id === id)) {
        loops.removeChild(button);
        buttons.delete(id);
      }
    }
    list.forEach((sample, index) => {
      let button = buttons.get(sample.id);
      if (!button) {
        button = option('', () => actions.toggleSample && actions.toggleSample(sample.id));
        button.dataset.loop = sample.id;
        // Held rather than double tapped, as everywhere else here.
        onHold(button, () => actions.removeSample && actions.removeSample(sample.id));
        button.title = 'tap to stop or start, hold to throw away';
        loops.appendChild(button);
        buttons.set(sample.id, button);
      }
      const named = sample.note ? `${sample.note.name}${sample.note.octave}` : `${index + 1}`;
      const label = `${named} ${sample.seconds.toFixed(1)}s`;
      if (button.textContent !== label) button.textContent = label;
      button.classList.toggle('on', sample.playing);
      button.classList.toggle('off', !sample.playing);
    });
  }

  const vocoder = group('VOCODER');
  const vocoderToggle = option('vocoder', () => state.set({ vocoder: !state.get().vocoder }),
    b => { b.dataset.toggle = 'vocoder'; });
  vocoderToggle.title = 'the microphone shapes the chords: hold a chord and speak';
  // The two things people get wrong: not holding a chord, since the vocoder has
  // nothing of its own to make a sound with, and using speakers, since a
  // microphone hearing the chords it is shaping is a loop.
  const how = document.createElement('div');
  how.className = 'statusbox';
  how.textContent = 'hold a chord and speak close, on headphones';
  const takeSamples = option('samples too', () => state.set({ vocoderSamples: !state.get().vocoderSamples }),
    b => { b.dataset.toggle = 'vocoderSamples'; });
  takeSamples.title = 'recorded loops go through the vocoder as well as the chords';
  vocoder.row.append(vocoderToggle, takeSamples, how);

  const formant = slider('FORMANT', -24, 24, 1, ' st', v => state.set({ vocoderFormant: v }));
  formant.el.title = 'moves the chords\' bands against the voice: up is smaller, down is taller';
  const q = slider('BAND Q', 0.5, 24, 0.1, '', v => state.set({ vocoderQ: v }));
  q.el.title = 'how narrow each band is: much above the default leaves gaps between them';
  const attack = slider('VOCODER ATTACK', 0.001, 0.2, 0.001, ' s',
    v => state.set({ vocoderAttack: v }));
  attack.el.title = 'how quickly a band opens: short enough and the consonants survive';
  const release = slider('VOCODER RELEASE', 0.005, 1, 0.005, ' s',
    v => state.set({ vocoderRelease: v }));
  release.el.title = 'how quickly a band closes again: short is crisp, long is smeared';
  const noise = slider('BREATH', 0, 100, 5, '%', v => state.set({ vocoderNoise: v / 100 }));
  noise.el.title = 'noise added to the chords so that s and t have something to be made of';
  const gate = slider('GATE', 0, 50, 1, '', v => state.set({ vocoderGate: v / 100 }));
  gate.el.title = 'how loud the room has to be before any of it counts as speech';

  el.append(access.el, tuner.el, sampler.el, speed.el, pitch.el, tone.el, vocoder.el,
    formant.el, q.el, attack.el, release.el, noise.el, gate.el);

  function say(box, text, quiet) {
    box.classList.toggle('empty', Boolean(quiet));
    if (box.textContent !== text) box.textContent = text;
  }

  return {
    el,
    update(next) {
      const live = next.mic === 'live';
      const asking = next.mic === 'asking';
      enable.classList.toggle('on', live);
      enable.disabled = next.mic === 'unavailable' || asking;
      enable.textContent = asking ? 'asking…' : 'microphone';
      say(micState, actions.micReason ? actions.micReason() : '', !live);

      tunerToggle.classList.toggle('on', Boolean(next.tuner));
      const note = next.tunerNote;
      if (!next.tuner) say(reading, 'off', true);
      else if (!note) say(reading, live ? 'listening…' : 'the microphone is not on', true);
      else {
        // Which way to move, in the words a tuner uses.
        const direction = note.cents > 4 ? 'sharp' : note.cents < -4 ? 'flat' : 'in tune';
        say(reading, `${note.name}${note.octave}  ${note.cents >= 0 ? '+' : ''}${note.cents}c  ${direction}`, false);
      }

      for (const b of sourceButtons) {
        b.classList.toggle('on', b.dataset.samplerSource === next.samplerSource);
      }
      const recording = next.sampler === 'recording';
      record.classList.toggle('on', recording);
      record.textContent = recording ? 'recording…' : 'hold to record';
      const list = actions.samples ? actions.samples() : [];
      clear.disabled = list.length === 0;
      renderLoops(list);
      for (const b of lengthButtons) {
        b.classList.toggle('on', Number(b.dataset.samplerBars) === (next.samplerBars || 0));
      }
      speed.set(Math.round(next.sampleSpeed * 20) / 20);
      pitch.set(Math.round(next.samplePitch));
      tape.classList.toggle('on', Boolean(next.sampleTape));
      tone.set(Math.round(next.sampleTone));
      const fromOut = next.samplerSource === 'out';
      const held = actions.lockedSeconds ? actions.lockedSeconds() : null;
      const bars = next.samplerBars || 0;
      const barName = bars >= 1 ? `${bars} bar${bars > 1 ? 's' : ''}` : `${bars * 4}/4 of a bar`;
      say(sampleState, recording
        ? bars
          ? `recording ${barName} from now`
          : held ? `let go, or it stops at ${held.toFixed(1)}s` : 'let go to loop it'
        : list.length
          ? `every take is ${held ? held.toFixed(1) : '?'}s, so they stay together`
          : fromOut
            ? 'hold the button and play: it records what you hear and loops it'
            : 'hold the button and make a sound: it loops as soon as you let go',
      !recording && list.length === 0);

      vocoderToggle.classList.toggle('on', Boolean(next.vocoder));
      takeSamples.classList.toggle('on', Boolean(next.vocoderSamples));
      formant.set(next.vocoderFormant);
      q.set(Math.round(next.vocoderQ * 10) / 10);
      attack.set(Math.round(next.vocoderAttack * 1000) / 1000);
      release.set(Math.round(next.vocoderRelease * 1000) / 1000);
      noise.set(Math.round(next.vocoderNoise * 100));
      gate.set(Math.round(next.vocoderGate * 100));
    },
  };
}
