import { group, option, slider } from '../controls.js';
import { MODES, MODE_IDS, ARP_PATTERNS, ARP_CHORD_MODES, ARP_CHORD_IDS, STRUM_SPEEDS } from '../../modes.js';
import { RATE_IDS } from '../../rates.js';
import { KITS, KIT_IDS } from '../../audio/drums.js';
import { AUTO_DRUM_RATES } from '../../audio/autodrum.js';
import { LEVELS as EAR_LEVELS } from '../../eartrainer.js';
import { PATTERNS, PATTERN_IDS, VARIATIONS, VARIATION_IDS } from '../../audio/patterns.js';

export function modePanel(state, actions = {}) {
  const el = document.createElement('div');
  el.className = 'panelbody';

  const modes = group('MODE');
  MODE_IDS.forEach(id => {
    modes.row.appendChild(option(MODES[id].label, () => state.set({ mode: id }), b => {
      b.dataset.mode = id;
    }));
  });

  const arp = group('ARP PATTERN');
  ARP_PATTERNS.forEach(id => {
    arp.row.appendChild(option(id, () => state.set({ arpPattern: id }), b => {
      b.dataset.arp = id;
    }));
  });

  // Shared with repeat: both are the transport playing what is held.
  const rate = group('ARP · REPEAT RATE');
  RATE_IDS.forEach(id => {
    rate.row.appendChild(option(id, () => state.set({ arpRate: id }), b => { b.dataset.rate = id; }));
  });

  const arpChord = group('ARP CHORD');
  ARP_CHORD_IDS.forEach(id => {
    arpChord.row.appendChild(option(ARP_CHORD_MODES[id].label,
      () => state.set({ arpChord: id }), b => { b.dataset.arpchord = id; }));
  });

  const strum = group('STRUM SPEED');
  Object.keys(STRUM_SPEEDS).forEach(id => {
    strum.row.appendChild(option(id, () => state.set({ strumSpeed: id }), b => {
      b.dataset.strum = id;
    }));
  });

  const kits = group('DRUM KIT');
  KIT_IDS.forEach(id => {
    kits.row.appendChild(option(KITS[id].label, () => state.set({ kit: id }), b => {
      b.dataset.kit = id;
    }));
  });

  const variations = group('BEAT STYLE');
  VARIATION_IDS.forEach(id => {
    variations.row.appendChild(option(VARIATIONS[id].label,
      () => state.set({ beatVariation: id }), b => { b.dataset.variation = id; }));
  });

  const auto = group('AUTO DRUM');
  AUTO_DRUM_RATES.forEach(id => {
    auto.row.appendChild(option(id, () => state.set({ autoDrum: id }), b => { b.dataset.auto = id; }));
  });

  const beats = group('BEAT');
  PATTERN_IDS.forEach(id => {
    const label = id === 'off' ? 'off' : PATTERNS[id].label;
    beats.row.appendChild(option(label, () => state.set({ beat: id }), b => { b.dataset.beat = id; }));
  });

  // The looper also has a control beside the pad, but that one is hidden while
  // a panel is open, and it was not obvious enough to find.
  const loop = group('LOOP');
  const loopToggle = option('record', () => actions.toggleLoop && actions.toggleLoop());
  const loopStop = option('stop', () => actions.stopLoop && actions.stopLoop());
  const loopPlay = option('play', () => actions.playLoop && actions.playLoop());
  const loopUndo = option('undo', () => actions.undoLoop && actions.undoLoop());
  const loopClear = option('clear', () => actions.clearLoop && actions.clearLoop());
  const metronome = option('click', () => state.set({ metronome: !state.get().metronome }),
    b => { b.dataset.toggle = 'metronome'; });
  const countIn = option('count in', () => state.set({ countIn: !state.get().countIn }),
    b => { b.dataset.toggle = 'countIn'; });
  countIn.title = 'four beats before recording starts';
  const bounce = option('auto bounce', () => state.set({ autoBounce: !state.get().autoBounce }),
    b => { b.dataset.toggle = 'autoBounce'; });
  bounce.title = 'leaving the sequencer or the drums keeps that pattern on a track';
  loop.row.append(loopToggle, loopStop, loopPlay, loopUndo, loopClear, metronome, countIn, bounce);

  // One row per recorded take: tap the name to mute it, the level to turn it
  // down. Built as tracks appear, because there is nothing to mix until then.
  const mixer = group('LOOP MIXER');
  const mixRows = [];

  function renderMixer(mix) {
    while (mixRows.length > mix.length) {
      const row = mixRows.pop();
      for (const el of [row.mute, row.level, row.live]) mixer.row.removeChild(el);
    }
    while (mixRows.length < mix.length) {
      const index = mixRows.length;
      const mute = option(`T${index + 1}`, () => actions.muteTrack && actions.muteTrack(index),
        b => { b.dataset.track = String(index); });
      const level = option('100%', () => actions.trackLevel && actions.trackLevel(index),
        b => { b.dataset.level = String(index); });
      const live = option('as rec', () => actions.trackLive && actions.trackLive(index),
        b => { b.dataset.live = String(index); });
      live.title = 'as rec: the sound it was played with. live: the sound on the panel now';
      mixer.row.append(mute, level, live);
      mixRows.push({ mute, level, live });
    }
    mix.forEach((track, i) => {
      const row = mixRows[i];
      row.mute.classList.toggle('off', track.muted);
      row.mute.classList.toggle('on', !track.muted);
      const text = `${Math.round(track.level * 100)}%`;
      if (row.level.textContent !== text) row.level.textContent = text;
      const liveText = track.live ? 'live' : 'as rec';
      if (row.live.textContent !== liveText) row.live.textContent = liveText;
      row.live.classList.toggle('on', track.live);
    });
    mixer.el.hidden = mix.length === 0;
  }

  // The ear trainer plays a chord and the pad answers it, so the only controls
  // it needs of its own are the level, the transport and a way to hear it again.
  const ear = group('EAR TRAINER');
  const earStatus = document.createElement('div');
  earStatus.className = 'statusbox empty';
  earStatus.dataset.ref = 'trainer';
  const earLevels = EAR_LEVELS.map(level => option(level.label,
    () => actions.trainerLevel && actions.trainerLevel(level.id),
    b => { b.dataset.level = String(level.id); }));
  const earStart = option('start', () => actions.startTrainer && actions.startTrainer());
  const earStop = option('stop', () => actions.stopTrainer && actions.stopTrainer());
  const earAgain = option('hear again', () => actions.replayQuestion && actions.replayQuestion());
  ear.row.append(earStatus, ...earLevels, earStart, earStop, earAgain);

  const seq = group('SEQUENCE');
  const seqSteps = document.createElement('div');
  seqSteps.className = 'seqsteps';
  const seqClear = option('clear', () => actions.clearSequence && actions.clearSequence());
  const seqUndo = option('undo', () => actions.undoSequence && actions.undoSequence());
  seq.row.append(seqSteps, seqUndo, seqClear);

  // The whole session, loops and all, saved as a file when it is stopped.
  const session = group('SESSION');
  const record = option('record', () => actions.toggleRecording && actions.toggleRecording());
  record.dataset.session = 'record';
  // What the file will be. Worth saying: over plain HTTP the browser will not
  // give us an audio worklet, so the session is encoded rather than written as
  // WAV, and on a browser with neither the button cannot work at all.
  const format = document.createElement('div');
  format.className = 'statusbox empty';
  format.dataset.ref = 'sessionFormat';
  session.row.append(record, format);

  const tempo = slider('TEMPO', 20, 400, 1, ' BPM', v => state.set({ bpm: v }));
  const tap = option('tap tempo', () => actions.tapTempo && actions.tapTempo());
  tap.dataset.tap = 'tempo';
  tempo.el.appendChild(tap);

  el.append(modes.el, seq.el, loop.el, mixer.el, session.el, beats.el, variations.el, arp.el, rate.el, arpChord.el, strum.el, kits.el, auto.el, ear.el, tempo.el);

  return {
    el,
    update(next) {
      for (const b of modes.row.children) b.classList.toggle('on', b.dataset.mode === next.mode);
      for (const b of arp.row.children) b.classList.toggle('on', b.dataset.arp === next.arpPattern);
      for (const b of rate.row.children) b.classList.toggle('on', b.dataset.rate === next.arpRate);
      for (const b of arpChord.row.children) {
        b.classList.toggle('on', b.dataset.arpchord === next.arpChord);
      }
      for (const b of strum.row.children) b.classList.toggle('on', b.dataset.strum === next.strumSpeed);
      for (const b of kits.row.children) b.classList.toggle('on', b.dataset.kit === next.kit);
      for (const b of beats.row.children) b.classList.toggle('on', b.dataset.beat === next.beat);
      for (const b of auto.row.children) b.classList.toggle('on', b.dataset.auto === next.autoDrum);
      for (const b of variations.row.children) {
        b.classList.toggle('on', b.dataset.variation === next.beatVariation);
      }
      const ears = next.trainer || { level: 1, running: false, asked: 0, right: 0, last: null };
      for (const b of earLevels) b.classList.toggle('on', Number(b.dataset.level) === ears.level);
      earStart.classList.toggle('on', ears.running);
      const heard = ears.running
        ? `${ears.right}/${ears.asked}${ears.last ? ` · ${ears.last}` : ''} · which chord?`
        : 'press start, then answer on the pad';
      earStatus.classList.toggle('empty', !ears.running);
      if (earStatus.textContent !== heard) earStatus.textContent = heard;

      renderMixer((next.looper && next.looper.mix) || []);
      const mode = next.looper ? next.looper.mode : 'off';
      loopToggle.textContent = mode === 'off' ? 'record'
        : mode === 'counting' ? 'counting'
        : mode === 'armed' ? 'waiting'
        : mode === 'recording' ? 'end take'
        : 'overdub';
      loopToggle.classList.toggle('on', mode === 'armed' || mode === 'recording' || mode === 'counting');
      metronome.classList.toggle('on', Boolean(next.metronome));
      countIn.classList.toggle('on', Boolean(next.countIn));
      bounce.classList.toggle('on', Boolean(next.autoBounce));
      loopStop.classList.toggle('on', mode === 'stopped');
      loopPlay.classList.toggle('on', mode === 'playing');
      for (const b of [loopStop, loopPlay, loopUndo, loopClear]) {
        b.disabled = mode === 'off';
        b.style.opacity = mode === 'off' ? '0.4' : '1';
      }
      const sequence = next.sequence || [];
      seqSteps.textContent = sequence.length
        ? sequence.map((degree, i) => (i === next.sequenceAt ? `[${degree + 1}]` : `${degree + 1}`)).join(' ')
        : 'press keys to write a progression';
      seqSteps.classList.toggle('empty', sequence.length === 0);
      record.textContent = next.recording ? 'stop and save' : 'record';
      record.classList.toggle('on', next.recording);
      const kind = actions.recordingFormat ? actions.recordingFormat() : null;
      record.disabled = kind === null;
      const says = kind === null
        ? 'this browser cannot record the session'
        : `saved as .${kind} when stopped`;
      if (format.textContent !== says) format.textContent = says;
      tempo.set(next.bpm);
    },
  };
}
