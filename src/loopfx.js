// Which settings reach a loop that is already recorded, and which the loop
// keeps as it was recorded.
//
// A category is off by default: a loop plays back the way it was recorded, and
// reaching for the reverb or a different sound while it runs changes only the
// hands. Three kinds, because they take effect in three places:
//
//   fx      the loop has its own effects rack, so these are rack settings
//   voice   how a recorded note is sounded: its instrument, filter, envelope
//   theory  which notes it is, which means the chord has to be built again
//
// The mixer's own as rec / live switch per track is the shortcut for all of
// them at once, for one track.

export const CATEGORIES = [
  { id: 'reverb', kind: 'fx', keys: ['reverb', 'reverbMix', 'reverbTime'] },
  { id: 'chorus', kind: 'fx', keys: ['chorus'] },
  { id: 'flanger', kind: 'fx', keys: ['flanger'] },
  { id: 'delay', kind: 'fx', keys: ['delay'] },
  { id: 'tremolo', kind: 'fx', keys: ['tremolo'] },
  { id: 'vibrato', kind: 'fx', keys: ['vibrato'] },

  { id: 'instrument', kind: 'voice', keys: ['instrument'] },
  { id: 'cutoff', kind: 'voice', keys: ['cutoff'] },
  { id: 'voices', kind: 'voice', keys: ['voices'] },
  { id: 'adsr', kind: 'voice', keys: ['adsr'] },
  { id: 'stereo', kind: 'voice', keys: ['stereo'] },

  { id: 'keyRoot', kind: 'theory', keys: ['keyRoot'] },
  { id: 'scale', kind: 'theory', keys: ['scale'] },
  { id: 'baseOctave', kind: 'theory', keys: ['baseOctave'] },
  { id: 'inversion', kind: 'theory', keys: ['inversion'] },
  { id: 'voiceLeading', kind: 'theory', keys: ['voiceLeading'] },
  { id: 'bass', kind: 'theory', keys: ['bass'] },
];

export const CATEGORY_IDS = CATEGORIES.map(category => category.id);

const of = kind => CATEGORIES.filter(category => category.kind === kind);

export const FX_CATEGORIES = of('fx');
export const VOICE_CATEGORIES = of('voice');
export const THEORY_CATEGORIES = of('theory');

export const FX_KEYS = FX_CATEGORIES.flatMap(category => category.keys);

// Everything the racks and the vocoder are built from. A key press changes none
// of it, and re-applying the lot on every press is a hundred parameter writes
// on the thread the audio is scheduled from.
export const SOUND_SETTING_KEYS = [
  ...FX_KEYS, 'bpm', 'toLoop', 'toSample',
  // The microphone features are applied in the same pass, so what they are
  // built from belongs here too: leaving the tuner out of this list left it
  // switched on in the interface and not listening to anything.
  'mic', 'tuner', 'sampleSpeed', 'samplePitch', 'sampleTape', 'sampleTone', 'vocoder', 'vocoderSamples', 'vocoderFormant', 'vocoderQ', 'vocoderAttack', 'vocoderRelease',
  'vocoderNoise', 'vocoderGate',
];

export function soundSettingsChanged(before, after) {
  if (!before) return true;
  return SOUND_SETTING_KEYS.some(key => before[key] !== after[key]);
}
export const THEORY_KEYS = THEORY_CATEGORIES.flatMap(category => category.keys);

// What the rack was set to at the moment recording began. Kept so a loop can go
// on sounding the way it did, whatever is changed afterwards.
export function snapshotFx(state) {
  const out = {};
  for (const key of FX_KEYS) out[key] = state[key];
  return out;
}

// The theory a chord was played under, recorded with it so the chord can be
// built again later against a mix of then and now.
export function snapshotTheory(state) {
  const out = {};
  for (const key of THEORY_KEYS) out[key] = state[key];
  return out;
}

// Everything off. Given to the loop rack while there is no loop, since nothing
// is going through it and an effect that is merely turned down still costs what
// it costs: a convolver is pulled every render quantum either way.
export function noFxSettings(bpm) {
  return { bpm, reverb: false, reverbMix: 0, chorus: false, flanger: false,
    delay: 'off', tremolo: 'off', vibrato: 'off' };
}

// The settings the loop rack should be given: the live value for every category
// that is allowed through, and the recorded one for the rest. Tempo always comes
// from the transport, since the loop plays at whatever tempo is running.
export function loopFxSettings(live, frozen, follows = {}) {
  return { bpm: live.bpm, ...merge(FX_CATEGORIES, frozen || live, live, follows) };
}

// The settings a rack for the recorded samples should be given: the live value
// for every category allowed through, and off for the rest. Everything is
// allowed by default, since that is what a sample got when it shared the rack
// with the hands, and a setting quietly doing less than it did is worse than
// one doing more.
export function sampleFxSettings(live, allow = {}) {
  const off = noFxSettings(live.bpm);
  const follows = {};
  for (const category of FX_CATEGORIES) {
    follows[category.id] = allow[category.id] !== false;
  }
  return { bpm: live.bpm, ...merge(FX_CATEGORIES, off, live, follows) };
}

// Whether the samples need a rack of their own at all: only once something is
// being kept from them. Otherwise they share the one the hands use, which is
// what they have always done and costs nothing extra.
export function samplesNeedTheirOwnRack(allow = {}) {
  return FX_CATEGORIES.some(category => allow[category.id] === false);
}

// One rule for all three kinds: each category takes its values from the live
// state or from the recording. `all` is the mixer's per track live switch.
export function merge(categories, recorded, live, follows = {}, all = false) {
  const out = {};
  for (const category of categories) {
    const source = all || follows[category.id] ? live : recorded;
    for (const key of category.keys) out[key] = source[key];
  }
  return out;
}

// Whether a recorded chord has to be built again rather than replayed as the
// pitches it was: only if some part of the theory behind it now differs.
export function revoices(follows = {}, all = false) {
  return THEORY_CATEGORIES.some(category => all || follows[category.id]);
}
