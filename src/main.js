import { state } from './state.js';
import { createEngine } from './audio/engine.js';
import { createClock } from './clock.js';

import { createLooper, LOOPER_OFF, LOOPER_COUNTING } from './looper.js';
import { createTrainer } from './eartrainer.js';
import { createMic } from './audio/mic.js';
import { createSampler } from './audio/sampler.js';
import { createQueue } from './queued.js';
import { createTransportDial } from './ui/transport.js';
import { whyRunning, forgetSwitch, tapped } from './running.js';
import { snapshotFx, loopFxSettings, noFxSettings, soundSettingsChanged, sampleFxSettings, samplesNeedTheirOwnRack } from './loopfx.js';
import { createRecorder } from './audio/recorder.js';
import { tempoFromTaps } from './tempo.js';
import { onTap, onHold, enableDragScroll } from './ui/controls.js';
import { BUILD } from './version.js';
import { saveFile, stamp } from './download.js';
import { createModifiers } from './modifiers.js';
import { expandMods, nextLayer } from './layers.js';
import { createInput } from './input.js';
import { mountLayout } from './ui/layout.js';
import { renderPad } from './ui/pad.js';
import { renderModpad } from './ui/modpad.js';
import { renderReadout } from './ui/readout.js';
import { keyPanel } from './ui/panels/key.js';
import { soundPanel } from './ui/panels/sound.js';
import { modePanel } from './ui/panels/mode.js';
import { micPanel } from './ui/panels/mic.js';
import { NOTE_NAMES, SCALES } from './theory.js';
import { MODES } from './modes.js';
import { INSTRUMENTS } from './audio/instruments.js';

const refs = mountLayout(document.getElementById('app'));
const engine = createEngine({});
const modifiers = createModifiers({ expand: expandMods });
const clock = createClock({ getTime: () => (engine.context() ? engine.context().currentTime : 0) });
const looper = createLooper({
  clock,
  onEvent: (event, time, stepDuration, track) => input.playRecorded(event, time, stepDuration, track),
  // So a take can begin on chords that were already being held, each written
  // down fading the way it would have faded had the finger lifted.
  soundingNow: () => engine.soundingNow().map(held => ({
    ...held,
    opts: { ...held.opts, release: input.releaseFor(held) },
  })),
  onChange: status => state.set({ looper: status }),
});
const trainer = createTrainer();
const mic = createMic({ engine });
const sampler = createSampler({ engine, mic, clock });

// The tuner listens a few times a second: often enough to follow a note being
// tuned, rarely enough that working out a pitch is not the main thing the page
// is doing.
const TUNER_INTERVAL_MS = 120;
let tunerTimer = null;

function followTuner(on) {
  if (on && tunerTimer === null) {
    tunerTimer = setInterval(() => state.set({ tunerNote: mic.hear() }), TUNER_INTERVAL_MS);
  } else if (!on && tunerTimer !== null) {
    clearInterval(tunerTimer);
    tunerTimer = null;
    state.set({ tunerNote: null });
  }
}

mic.onChange(micState => state.set({ mic: micState }));
sampler.onChange((recording, samples) => {
  const latest = samples.length ? samples[samples.length - 1] : null;
  state.set({
    sampler: recording ? 'recording' : (samples.length ? 'ready' : 'empty'),
    sampleCount: samples.length,
    samplerNote: latest ? latest.note : null,
  });
  // The most recent recording is also what the keys play when the mic
  // instrument is chosen, so it goes to the sample library as well.
  if (latest) {
    engine.putSample('mic', latest.buffer, latest.semitone);
    input.rebuildAllHeld({ force: true });
  } else {
    engine.forgetSample('mic');
  }
});

// A press is an answer while the trainer is running, and an ordinary chord the
// rest of the time. The trainer marks it, then asks the next question.
function answerTrainer(chord) {
  if (!trainer.state().running) return;
  const next = trainer.answer(chord);
  publishTrainer(next);
  setTimeout(() => askTrainer(), 700);
}

const input = createInput({ state, engine, modifiers, clock, onChord: answerTrainer });

function publishTrainer({ level, running, asked, right, last }) {
  state.set({ trainer: { level, running, asked, right, last } });
}

function askTrainer() {
  const { question, running } = trainer.state();
  if (running && question) input.playChordFor(question);
}
clock.onStep(event => looper.onStep(event));

// Anything held for the downbeat happens here, before the step is played, so a
// key change and the first chord of the bar are the same moment.
clock.onStep(({ step }) => queue.step(step));

// Where the transport has got to. Steps arrive ahead of when they sound, since
// that is what gives the audio time to be scheduled, so the dial is moved when
// the beat actually happens rather than when it is written down.
const dial = createTransportDial();
refs.transport.appendChild(dial.el);
onTap(dial.el, () => state.set({ transport: tapped(state.get()) }));
clock.onStep(({ step, time }) => {
  const now = engine.context() ? engine.context().currentTime : time;
  // Never further ahead than the beat itself: a context that has not been
  // allowed to start yet reports a time that does not move, which would park
  // every one of these somewhere in the next hour.
  const wait = Math.min(clock.stepDuration() * 1000, Math.max(0, (time - now) * 1000));
  setTimeout(() => { if (clock.isRunning()) dial.at(step); }, wait);
});

// The metronome, and the count that leads into a take. Made here rather than in
// the looper, which makes no sounds, or in the input, which does not know there
// is a looper at all.
clock.onStep(({ step, time }) => {
  const s = state.get();
  const counting = looper.state().mode === LOOPER_COUNTING;
  if (!counting && !s.metronome) return;
  if (step % 4 !== 0) return;
  engine.click(time, step % 16 === 0);
});

// The looper listens to the engine rather than to the keys, so it records what
// was sounded whatever produced it: a chord, an arpeggio, a drum or a drone.
engine.onSound(event => looper.record(event, input.currentStep(), clock.stepDuration()));

const pad = renderPad(refs, {
  onDown: input.chordDown,
  onUp: input.chordUp,
  onSlide: input.chordSlide,
  onLeave: () => { input.releaseHeld(); state.set({}); },
  isHolding: pointerId => input.holdsPointer(pointerId),
});
const modpad = renderModpad(refs, {
  onPress: input.modPress,
  onRelease: input.modRelease,
  onLayer: () => state.set({ modLayer: nextLayer(state.get().modLayer) }),
});
const readout = renderReadout(refs);

const recorder = createRecorder({ engine });

// Three taps is the fewest that describes a tempo rather than a single gap.
let taps = [];
function tapTempo() {
  taps.push(performance.now());
  if (taps.length > 8) taps = taps.slice(-8);
  const bpm = tempoFromTaps(taps);
  if (bpm !== null) state.set({ bpm });
}

// A finished recording is handed over as a file. The page is opened in a real
// browser, so a link with a download attribute is all that is needed.
function saveRecording(result) {
  saveFile(`chordpad-${stamp()}.${result.extension}`, result.blob);
}

async function toggleRecording() {
  if (recorder.isRecording()) {
    state.set({ recording: false });
    const result = await recorder.stop();
    if (result) saveRecording(result);
    return;
  }
  engine.ensureContext();
  // Audio has to be running before there is anything to tap, and on a first
  // gesture the context may still be warming up.
  engine.unlock();
  const started = await recorder.start();
  state.set({ recording: started });
  if (!started) console.warn('chordpad: this browser will not record the session');
}

// A sampled instrument that is already in the browser cache loads inside a
// frame, and marking it as loading for that long is a flicker rather than
// information. The mark is held back until the wait is worth mentioning.
const SLOW_LOAD_MS = 200;
const loadingSince = new Map();

function instrumentMark(id) {
  const status = engine.instrumentStatus(id);
  if (status !== 'loading') {
    loadingSince.delete(id);
    return status;
  }
  const since = loadingSince.get(id);
  if (since === undefined) {
    loadingSince.set(id, Date.now());
    // Nothing else will redraw the panel if the load turns out to be slow.
    setTimeout(refreshPanel, SLOW_LOAD_MS + 20);
    return 'ready';
  }
  return Date.now() - since >= SLOW_LOAD_MS ? 'loading' : 'ready';
}

function refreshPanel() {
  if (openTab) panels[openTab].update(state.get());
}

// The panels change settings through this rather than through state directly,
// so whether a change waits for the downbeat is decided in one place rather
// than at every control that could be changed.
const queue = createQueue({
  state,
  clock,
  onPending: waiting => state.set({ pending: waiting }),
});

const settings = {
  get: () => state.get(),
  subscribe: fn => state.subscribe(fn),
  set(patch) {
    if (!state.get().onTheBeat) return state.set(patch);
    return queue.hold(patch);
  },
};

const panels = {
  key: keyPanel(settings),
  sound: soundPanel(settings, { instrumentStatus: instrumentMark }),
  mic: micPanel(settings, {
    enableMic: () => mic.enable(),
    disableMic: () => { mic.disable(); state.set({ tuner: false, vocoder: false }); },
    micReason: () => mic.reason(),
    startRecording: () => sampler.start({
      from: state.get().samplerSource,
      bars: state.get().samplerBars,
    }),
    stopRecording: () => sampler.stop(),
    samples: () => sampler.samples(),
    toggleSample: id => sampler.toggle(id),
    removeSample: id => sampler.remove(id),
    clearSamples: () => sampler.clear(),
    lockedSeconds: () => sampler.lockedSeconds(),
  }),
  mode: modePanel(settings, {
    toggleLoop: () => looper.toggle(input.currentStep(), { countIn: state.get().countIn }),
    stopLoop: () => looper.stop(),
    playLoop: () => looper.play(),
    undoLoop: () => looper.undo(),
    clearLoop: () => looper.clear(),
    muteTrack: index => looper.toggleMute(index),
    trackLevel: index => looper.cycleLevel(index),
    trackLive: index => looper.toggleLive(index),
    toggleRecording,
    recordingFormat: () => recorder.format(),
    tapTempo,
    trainerLevel: (level) => {
      publishTrainer(trainer.setLevel(level));
      if (trainer.state().running) publishTrainer(trainer.start());
      askTrainer();
    },
    startTrainer: () => {
      publishTrainer(trainer.start());
      askTrainer();
    },
    stopTrainer: () => publishTrainer(trainer.stop()),
    replayQuestion: askTrainer,
    clearSequence: () => {
      input.sequencer.clear();
      state.set({ sequence: [], sequenceAt: -1 });
    },
    undoSequence: () => {
      input.sequencer.removeLast();
      state.set({ sequence: input.sequencer.steps().map(step => step.degreeIndex) });
    },
  }),
};

// The drawer shares the chord pad's grid cell and covers it while open, so the
// tab strip below stays reachable and nothing is pushed off screen.
const drawer = document.createElement('div');
drawer.className = 'drawer';
refs.tabs.parentElement.appendChild(drawer);
enableDragScroll(drawer);

const TABS = [
  ['key', 'gray', 'KEY', 'scale · voicing'],
  ['sound', 'yellow', 'SOUND', 'instrument · fx'],
  ['mode', 'red', 'MODE', 'beat · arp · bpm'],
  ['mic', 'blue', 'MIC', 'tuner · sampler · vocoder'],
];

let openTab = null;

function openPanel(id) {
  openTab = openTab === id ? null : id;
  drawer.innerHTML = '';
  if (openTab) {
    drawer.appendChild(panels[openTab].el);
    panels[openTab].update(state.get());
  }
  for (const tab of refs.tabs.children) {
    tab.classList.toggle('on', tab.dataset.tab === openTab);
  }
  // The panel takes the modifier pad's place rather than covering the keys, so
  // a setting can be changed with one thumb while the other holds a chord.
  document.getElementById('app').classList.toggle('panelopen', Boolean(openTab));
}

for (const [id, colour, label, sub] of TABS) {
  const tab = document.createElement('div');
  tab.className = `tab ${colour}`;
  tab.dataset.tab = id;
  tab.innerHTML = `<span class="swatch"></span>${label}<span class="sub">${sub}</span>`;
  onTap(tab, () => openPanel(id));
  refs.tabs.appendChild(tab);
}

// Tapping the readout silences everything, which is the way out of a note that
// has somehow been left sounding.
onTap(refs.readout, () => {
  input.releaseEverything();
  state.set({});
});

// Bound to pointerdown, so the loop can be started and stopped with a second
// thumb without letting go of the chord, which is the whole point of a looper.
onTap(refs.looper, () => looper.toggle(input.currentStep(), { countIn: state.get().countIn }));
// Held rather than tapped, the way a pedal's stop is: it keeps the take.
onHold(refs.looper, () => looper.stop());

refs.volume.addEventListener('input', () => {
  const v = parseInt(refs.volume.value, 10) / 100;
  state.set({ volume: v });
  engine.setVolume(v);
});

// One strip carries the whole status: key and scale, tempo, mode, instrument and
// octave. Nothing is repeated anywhere else, and the ones worth changing in a
// hurry are tappable.
// Built once and updated in place. Rebuilding this strip on every state change
// meant tearing down and recreating five elements each time a key was pressed
// or released, which is layout work competing with the audio thread at exactly
// the wrong moment.
function chip(label, onPress) {
  const el = document.createElement('div');
  el.className = onPress ? 'chip tappable' : 'chip';
  const value = document.createElement('b');
  el.append(document.createTextNode(label ? `${label} ` : ''), value);
  if (onPress) onTap(el, onPress);
  return { el, value, last: null };
}

const CHIPS = {
  key: chip('KEY', () => openPanel('key')),
  bpm: chip('', () => openPanel('mode')),
  mode: chip('', () => openPanel('mode')),
  instrument: chip('', () => openPanel('sound')),
  // Tapping the octave cycles it, which is quicker than opening a panel for the
  // one setting most likely to be nudged mid play.
  // A padlock rather than a word: it is a control, and it has to fit next to
  // four other chips on a phone.
  hold: chip('', () => state.set({ hold: !state.get().hold })),
  // Whether a key, a sound or a mode lands now or on the next downbeat. Timing
  // it by hand means changing it early enough to land on time, and how early
  // depends on the tempo. Labelled with what it decides rather than with the
  // word "beat" on its own, which is both easy to miss among the others and
  // already the name of the drum pattern.
  beat: chip('CHANGES', () => {
    const on = !state.get().onTheBeat;
    state.set({ onTheBeat: on });
    // Switched off with something still waiting, it happens now rather than
    // being lost.
    if (!on) queue.flushNow();
  }),
  octave: chip('OCT', () => {
    const current = state.get().baseOctave;
    state.set({ baseOctave: current >= 6 ? 2 : current + 1 });
  }),
};

refs.chips.append(...Object.values(CHIPS).map(c => c.el));

function setChip(chipRef, text) {
  if (chipRef.last === text) return;
  chipRef.last = text;
  chipRef.value.textContent = text;
}

function renderChips(s) {
  setChip(CHIPS.key, `${NOTE_NAMES[s.keyRoot]} ${(SCALES[s.scale] || SCALES.major).name}`);
  setChip(CHIPS.bpm, `${s.bpm} BPM`);
  setChip(CHIPS.mode, MODES[s.mode] ? MODES[s.mode].label : s.mode);
  setChip(CHIPS.instrument,
    INSTRUMENTS[s.instrument] ? INSTRUMENTS[s.instrument].label : s.instrument);
  setChip(CHIPS.octave, String(s.baseOctave));
  setChip(CHIPS.hold, s.hold ? '\u{1F512} hold' : '\u{1F513} hold');
  CHIPS.hold.el.classList.toggle('on', s.hold);
  const waiting = Object.keys(s.pending || {}).length;
  setChip(CHIPS.beat, s.onTheBeat
    ? (waiting ? `on the beat \u00b7 ${waiting} waiting` : 'on the beat')
    : 'now');
  CHIPS.beat.el.classList.toggle('on', Boolean(s.onTheBeat));
  // Something is waiting for the downbeat, which is worth being able to see.
  CHIPS.beat.el.classList.toggle('waiting', waiting > 0);
}

// The transport only runs when a mode needs it, so nothing ticks while playing
// plain chords.
// Anything that changes what a held chord should sound like has to reach the
// notes that are already sounding, not just the next ones. Pitch changes are
// retuned into, a different instrument has to be rebuilt, and the filter is
// simply moved.
const RETUNE_ON = ['keyRoot', 'scale', 'baseOctave', 'inversion', 'bass', 'voiceLeading'];
const REBUILD_ON = ['instrument', 'adsr', 'stereo', 'voices'];
let previous = null;

// Leaving the sequencer or the drums drops what was playing onto a looper track,
// so a pattern worked out in one mode is still there to play over in another.
function autoBounce(previousMode, s) {
  if (!s.autoBounce || previousMode === s.mode) return;
  const bounced = previousMode === 'sequencer' ? input.bounceSequence()
    : previousMode === 'drums' ? input.bounceBeat()
      : null;
  if (bounced) looper.addTrack(bounced.events, bounced.steps, input.currentStep());
}

function applyLiveChanges(s) {
  if (!previous) return;
  autoBounce(previous.mode, s);
  // Choosing a sampled instrument is what fetches it. Nothing waits: the
  // fallback voice plays until the recordings land, and then held chords are
  // built again so the change is heard without pressing the key twice.
  if (previous.instrument !== s.instrument) engine.loadInstrument(s.instrument);
  // A drone deliberately outlives the finger that started it, but leaving drone
  // mode has to end it, or the note becomes unkillable.
  if (previous.mode === 'drone' && s.mode !== 'drone') input.releaseEverything();
  // Unlocking lets go of everything the lock was holding.
  if (previous.hold && !s.hold) input.releaseSustained();
  if (RETUNE_ON.some(key => previous[key] !== s[key])) input.rebuildAllHeld();
  // The voice itself is built from these, so a held chord has to be built
  // again: there is nothing to retune into.
  if (REBUILD_ON.some(key => previous[key] !== s[key])) input.rebuildAllHeld({ force: true });
  if (previous.cutoff !== s.cutoff) input.applyTone();
}

// The effects a loop was recorded with. Kept from the moment recording starts,
// so a loop goes on sounding the way it did while the hands move on; each
// category can be let through to it from the SOUND panel.
let recordedFx = null;

// The tuner, and the vocoder's settings. Both want the microphone, and both are
// switched off by themselves if it goes away, so nothing waits on a permission
// that was refused.
function applyMicFeatures(s) {
  const live = s.mic === 'live';
  followTuner(Boolean(s.tuner) && live);
  // Loaded the first time a loop is asked to hold its pitch, and not before: a
  // loop at its own pitch and speed sounds the same either way, to the sample.
  if (s.samplePitch && !engine.grainPlayerReady()) engine.loadGrainPlayer();
  engine.applySampleLoops({ speed: s.sampleSpeed, tone: s.sampleTone,
    pitch: s.samplePitch, tape: s.sampleTape });

  const on = Boolean(s.vocoder) && live;
  engine.applyVocoder({
    on,
    samples: Boolean(s.vocoderSamples),
    formant: s.vocoderFormant,
    q: s.vocoderQ,
    attack: s.vocoderAttack,
    release: s.vocoderRelease,
    noise: s.vocoderNoise,
    gate: s.vocoderGate,
  });
  // The microphone is what the vocoder listens to, and there is nowhere to
  // connect it until the vocoder has been built. What is remembered is the node
  // that was connected rather than that one was: stopping the microphone throws
  // its node away, and a flag saying "connected" then describes a node that no
  // longer exists.
  const into = engine.vocoderInput();
  const source = mic.source();
  if (vocoderListens && (!on || vocoderListens !== source)) {
    try { vocoderListens.disconnect(into); } catch { /* already gone */ }
    vocoderListens = null;
  }
  if (on && into && source && !vocoderListens) {
    source.connect(into);
    vocoderListens = source;
  }
}

let vocoderListens = null;

// The recorded samples share the rack the hands use until something is being
// kept from them, and only then get one of their own. Building one nobody has
// asked for is 22 ms of every four seconds of audio for nothing.
function applySampleFx(s) {
  const separate = samplesNeedTheirOwnRack(s.toSample);
  engine.applySampleEffects(sampleFxSettings(s, s.toSample), separate);
}

function applyLoopFx(s) {
  const idle = s.looper.mode === LOOPER_OFF;
  if (idle) {
    // Nothing is going through the loop rack, so it is given nothing to do
    // rather than a copy of what the hands are playing through.
    recordedFx = null;
    engine.applyLoopEffects(noFxSettings(s.bpm));
    return;
  }
  if (!recordedFx) recordedFx = snapshotFx(s);
  engine.applyLoopEffects(loopFxSettings(s, recordedFx, s.toLoop));
}

state.subscribe(s => {
  // Kept before anything reassigns it, since two things want to know what
  // changed and one of them runs after the other has moved on.
  const before = previous;
  clock.setBpm(s.bpm);
  // Only when one of them has actually changed. A key press changes what is
  // held and nothing else, and re-applying two effects racks and sixteen
  // vocoder bands on every press is work on the thread that has to be free to
  // schedule the note.
  if (soundSettingsChanged(previous, s) || s.looper.mode !== (previous && previous.looper.mode)) {
    engine.applyEffects(s);
    applyLoopFx(s);
    applySampleFx(s);
    applyMicFeatures(s);
  }
  applyLiveChanges(s);
  previous = s;
  // A switch by hand is forgotten once what the instrument itself needs has
  // changed, since the hand's answer was to a different question by then:
  // selecting a drum pattern and hearing nothing reads as the app being broken
  // rather than as an earlier decision being honoured.
  if (forgetSwitch(before, s)) {
    state.set({ transport: 'auto' });
    return;
  }
  const driving = whyRunning(s);
  dial.because(driving);
  if (driving) clock.start();
  else {
    clock.stop();
    // A playhead stopped part way along looks like one that is still running.
    dial.idle();
  }
  pad.update(s);
  modpad.update(s);
  readout.update(s);
  renderChips(s);
  const volumeText = String(Math.round(s.volume * 100));
  if (refs.volumeValue.textContent !== volumeText) refs.volumeValue.textContent = volumeText;
  const looperText = s.looper.mode === LOOPER_OFF
    ? 'tap to record'
    : `${s.looper.mode} · ${s.looper.tracks} track${s.looper.tracks === 1 ? '' : 's'}`;
  if (refs.looperState.textContent !== looperText) refs.looperState.textContent = looperText;
  refs.looper.classList.toggle('on', s.looper.mode !== LOOPER_OFF);
  if (openTab) panels[openTab].update(s);
});

// Per the HTML standard, pointerdown grants user activation only when
// pointerType is "mouse". Touch has to wait for pointerup or touchend, so on a
// touchscreen the first press cannot make a sound however it is written. A mouse
// needs nothing: it unlocks inside the press, so it never sees this overlay.
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];

const needsGate = () => !engine.isRunning()
  && navigator.maxTouchPoints > 0
  && window.matchMedia('(pointer: coarse)').matches;

let gate = null;

function showGate() {
  if (gate) return;
  gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = '<div class="gatetext">TAP TO START</div>';
  document.body.appendChild(gate);
}

function audioStarted() {
  for (const type of UNLOCK_EVENTS) {
    document.removeEventListener(type, tryUnlock, { capture: true });
  }
  if (gate) {
    gate.remove();
    gate = null;
  }
}

function tryUnlock() {
  // unlock() reports the state as it is right now, and resume() settles later,
  // so success is recognised by the context saying so, not by this return value.
  if (engine.unlock()) audioStarted();
}

for (const type of UNLOCK_EVENTS) {
  document.addEventListener(type, tryUnlock, { capture: true });
}

const audioContext = engine.ensureContext();
audioContext.addEventListener('statechange', () => {
  if (engine.isRunning()) audioStarted();
});
if (needsGate()) showGate();

// The moment an instrument's recordings arrive, anything sounding on the
// fallback voice is rebuilt on the real one, and the panel stops saying loading.
engine.onSamplesReady(() => {
  input.rebuildAllHeld({ force: true });
  refreshPanel();
});

// How far ahead to schedule, by how much attention the window is getting. A
// page that is not being looked at has its timers throttled, and a page that is
// merely not focused can still be starved for a moment when the desktop is
// busy switching windows. Neither is a moment when a control is being touched,
// so scheduling further ahead there costs nothing and is the difference between
// a loop that keeps playing and one that gaps.
// Enough to ride out a late pump, and no more: every step scheduled ahead is a
// set of voices sitting in the graph being pulled every render quantum before
// it sounds, and a deep queue is itself a reason the audio thread falls behind.
// Measured on the machine that was cracking, the worst the scheduler was ever
// late by is around a tenth of a second, so these are two to eight times the
// margin actually needed.
const LOOKAHEAD = { focused: 0.15, unfocused: 0.35, hidden: 0.8 };

function attention() {
  if (typeof document !== 'undefined' && document.hidden) return 'hidden';
  if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) {
    return 'unfocused';
  }
  return 'focused';
}

function followAttention() {
  clock.setLookahead(LOOKAHEAD[attention()]);
  // A context can come back suspended after the window has been away, and then
  // nothing sounds however well it is scheduled.
  if (engine.context() && !engine.isRunning()) engine.unlock();
}

if (typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', followAttention);
  globalThis.addEventListener('blur', followAttention);
  globalThis.addEventListener('focus', followAttention);
}

console.info(`chordpad build ${BUILD}`);
refs.build.textContent = `build ${BUILD}`;

// The PWA experiment registered a service worker before it was reverted. A
// registered worker keeps controlling the page even after its script is gone,
// serving whatever it cached, which no server header can override. Nothing here
// uses one any more, so any that exists is removed and its caches emptied.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(registrations => {
      if (registrations.length === 0) return null;
      console.warn(`chordpad: removing ${registrations.length} stale service worker(s)`);
      return Promise.all(registrations.map(r => r.unregister()))
        .then(() => (globalThis.caches ? caches.keys() : []))
        .then(keys => Promise.all(keys.map(key => caches.delete(key))))
        // The page is still being served by the worker that was just removed,
        // so one reload is needed to pick up the real files.
        .then(() => location.reload());
    })
    .catch(err => console.error('service worker cleanup', err));
}
state.set({});

if (new URLSearchParams(location.search).has('debug')) {
  import('./debug.js').then(({ attachDebug }) => attachDebug(engine, clock));
  // A recorded take is the one thing there is no other way to look at.
  globalThis.__chordpad = { looper, engine, input, state, clock, recorder, mic, sampler,
    vocoderWiring: () => ({ listening: vocoderListens === mic.source() && vocoderListens !== null }) };
}
