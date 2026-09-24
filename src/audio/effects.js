// The effects rack. Built once at startup and re-parameterised from state, so
// switching an effect on never rebuilds the graph or interrupts a held note.
//
// Signal order: input -> chorus -> tremolo -> delay -> reverb -> output.
// Every effect is a parallel wet path, so "off" means a wet gain of zero rather
// than a disconnected node.

const DELAY_DIVISIONS = { off: 0, '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/16T': 1 / 6 };
const TREMOLO_DIVISIONS = { off: 0, '1/4': 1, '1/8': 2, '1/16': 4, '1/32': 8 };

// Vibrato is pitch rather than volume, so its depth is in cents.
const VIBRATO_CENTS = { off: 0, low: 8, med: 20, high: 45 };
const VIBRATO_RATE = 5.2;

export const DELAY_TIMES = Object.keys(DELAY_DIVISIONS);
export const TREMOLO_RATES = Object.keys(TREMOLO_DIVISIONS);
export const VIBRATO_DEPTHS = Object.keys(VIBRATO_CENTS);

// Every change is ramped rather than assigned. A gain multiplying a signal that
// is already sounding cannot step: switching the tremolo on used to jump its
// depth from nothing to full between one sample and the next, which is a click.
// Short enough to feel immediate, long enough that no edge is heard.
const RAMP = 0.02;

function ramp(param, value, ctx, seconds = RAMP) {
  if (typeof param.setTargetAtTime !== 'function' || !ctx) {
    param.value = value;
    return;
  }
  // A time constant reaches about 95 percent in three of them.
  param.setTargetAtTime(value, ctx.currentTime, seconds / 3);
}

// How long a room may be asked to ring for. Four seconds is a cathedral; past
// that a synthesised noise response stops sounding like a room and starts
// costing real work, since a convolution is as long as its response and there
// are two racks running one each.
// Quarter second steps from a small room to a cathedral, so every value the
// slider can take is one the clamp would choose anyway.
export const REVERB_SECONDS = { min: 0.25, max: 12, default: 2.25, step: 0.25 };

// Above this the slider rounds to whole seconds rather than quarters. A
// response is built per distinct length and a long one is megabytes, so fine
// steps at the long end are a lot of arithmetic and a lot of memory for a
// difference nobody can hear: half a second in twelve is nothing.
const COARSE_ABOVE = 4;

export function clampReverbSeconds(seconds) {
  const wanted = Number(seconds);
  if (!Number.isFinite(wanted)) return REVERB_SECONDS.default;
  // Rounded, which is finer than anyone can hear and keeps the number of
  // responses ever built to a handful.
  const stepped = wanted > COARSE_ABOVE ? Math.round(wanted) : Math.round(wanted * 4) / 4;
  return Math.min(REVERB_SECONDS.max, Math.max(REVERB_SECONDS.min, stepped));
}

// Responses are shared by every rack on a context and built once each: a loop
// rack and a live rack asking for the same room get the same buffer, and going
// back to a length that has been used before costs nothing.
const responses = new WeakMap();

// How much of them to keep, in seconds of stereo. A twelve second room is four
// megabytes, so keeping every length anybody ever dragged through is a hundred
// megabytes on a phone. The oldest go first, and coming back to one costs the
// one build it cost the first time.
const KEEP_SECONDS = 40;

// A short noise burst with an exponential decay makes a serviceable room
// without shipping an impulse response file. seconds is how long the room rings
// for, which is the thing people mean by the size of a reverb.
function impulseResponse(ctx, seconds = REVERB_SECONDS.default, decay = 3.2) {
  const rate = ctx.sampleRate || 48000;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  // The envelope is stepped rather than raised to a power per sample: the same
  // curve, without a million calls to Math.pow in the middle of a drag.
  const fade = Math.exp(-decay / length);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData ? buffer.getChannelData(channel) : null;
    if (!data) break;
    let envelope = 1;
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * envelope;
      envelope *= fade;
    }
  }
  return buffer;
}

function responseFor(ctx, seconds) {
  let byLength = responses.get(ctx);
  if (!byLength) {
    byLength = new Map();
    responses.set(ctx, byLength);
  }
  let buffer = byLength.get(seconds);
  if (!buffer) {
    buffer = impulseResponse(ctx, seconds);
    byLength.set(seconds, buffer);
  } else {
    // Touched, so that what is in use is not the next thing thrown away.
    byLength.delete(seconds);
    byLength.set(seconds, buffer);
  }
  let held = 0;
  for (const length of byLength.keys()) held += length;
  for (const length of byLength.keys()) {
    if (held <= KEEP_SECONDS || length === seconds) break;
    held -= length;
    byLength.delete(length);
  }
  return buffer;
}

export function createEffects(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // Chorus: a short modulated delay mixed back in, which thickens a thin
  // oscillator without sounding like an effect.
  const chorusDelay = ctx.createDelay(0.05);
  chorusDelay.delayTime.value = 0.025;
  const chorusLfo = ctx.createOscillator();
  const chorusDepth = ctx.createGain();
  chorusLfo.frequency.value = 0.6;
  chorusDepth.gain.value = 0.004;
  const chorusWet = ctx.createGain();
  chorusWet.gain.value = 0;
  chorusLfo.connect(chorusDepth);
  chorusDepth.connect(chorusDelay.delayTime);
  input.connect(chorusDelay);
  chorusDelay.connect(chorusWet);

  // Flanger: the same idea as the chorus but a shorter delay swept further and
  // fed back on itself, which is what turns thickening into a sweep.
  const flangeDelay = ctx.createDelay(0.02);
  flangeDelay.delayTime.value = 0.004;
  const flangeLfo = ctx.createOscillator();
  const flangeDepth = ctx.createGain();
  flangeLfo.frequency.value = 0.25;
  flangeDepth.gain.value = 0.003;
  const flangeFeedback = ctx.createGain();
  flangeFeedback.gain.value = 0.55;
  const flangeWet = ctx.createGain();
  flangeWet.gain.value = 0;
  flangeLfo.connect(flangeDepth);
  flangeDepth.connect(flangeDelay.delayTime);
  input.connect(flangeDelay);
  flangeDelay.connect(flangeFeedback);
  flangeFeedback.connect(flangeDelay);
  flangeDelay.connect(flangeWet);

  // Vibrato is not in the signal path at all: it is an LFO in cents that every voice
  // connects to its own oscillator detune, so one shared LFO keeps every key in
  // step with every other.
  const vibratoLfo = ctx.createOscillator();
  const vibrato = ctx.createGain();
  vibratoLfo.frequency.value = VIBRATO_RATE;
  vibrato.gain.value = 0;
  vibratoLfo.connect(vibrato);

  const tremolo = ctx.createGain();
  tremolo.gain.value = 1;
  const tremoloLfo = ctx.createOscillator();
  const tremoloDepth = ctx.createGain();
  tremoloLfo.frequency.value = 4;
  tremoloDepth.gain.value = 0;
  tremoloLfo.connect(tremoloDepth);
  tremoloDepth.connect(tremolo.gain);
  input.connect(tremolo);
  chorusWet.connect(tremolo);
  flangeWet.connect(tremolo);

  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.25;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.35;
  const delayWet = ctx.createGain();
  delayWet.gain.value = 0;
  tremolo.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(delayWet);

  const reverb = ctx.createConvolver();
  let reverbSeconds = REVERB_SECONDS.default;
  reverb.buffer = responseFor(ctx, reverbSeconds);

  // A convolver is pulled every render quantum whether or not anything is going
  // through it, and it costs the same either way: measured, two idle racks cost
  // more than everything being played through them. So an effect that is off is
  // taken out of the graph rather than turned down to nothing. Disconnected on
  // the way out only once the wet path has faded, connected on the way in
  // before it comes back, so neither is heard.
  let reverbEngaged = true;
  let disengaging = null;

  function engageReverb(on) {
    if (on === reverbEngaged) return;
    reverbEngaged = on;
    if (on) {
      // Asked for again before the fade finished: it never left, so cancelling
      // the departure is the whole of it.
      if (disengaging !== null) {
        clearTimeout(disengaging);
        disengaging = null;
        return;
      }
      reverb.connect(reverbWet);
      return;
    }
    disengaging = setTimeout(() => {
      disengaging = null;
      if (!reverbEngaged) reverb.disconnect();
    }, 120);
  }

  // Changing the room means a different impulse response, and swapping one
  // under a tail that is still ringing clicks, so the wet path is taken down
  // first and brought back after. A slider being dragged asks for a new length
  // every few milliseconds, and building one per answer is what made dragging
  // choppy: the change waits for the hand to settle, and the old room keeps
  // playing until it does.
  const SETTLE_MS = 150;
  let settling = null;
  let wanted = reverbSeconds;

  function setReverbSeconds(seconds, wet) {
    const next = clampReverbSeconds(seconds);
    if (next === wanted) return;
    wanted = next;
    if (settling !== null) clearTimeout(settling);
    settling = setTimeout(() => {
      settling = null;
      if (wanted === reverbSeconds) return;
      ramp(reverbWet.gain, 0, ctx);
      setTimeout(() => {
        try {
          reverb.buffer = responseFor(ctx, wanted);
          reverbSeconds = wanted;
        } catch (err) {
          // A room that cannot be built must not leave the reverb muted.
          console.error(err);
        } finally {
          ramp(reverbWet.gain, wet, ctx);
        }
      }, 40);
    }, SETTLE_MS);
  }
  const reverbWet = ctx.createGain();
  reverbWet.gain.value = 0;
  tremolo.connect(reverb);
  delayWet.connect(reverb);
  reverb.connect(reverbWet);

  tremolo.connect(output);
  delayWet.connect(output);
  reverbWet.connect(output);

  for (const lfo of [chorusLfo, flangeLfo, tremoloLfo, vibratoLfo]) {
    if (typeof lfo.start === 'function') lfo.start(0);
  }

  // Nothing is on when a rack is built, so the convolver starts out of the
  // graph rather than idling in it until something asks for reverb.
  reverb.disconnect();
  reverbEngaged = false;

  return {
    input,
    output,
    // Voices connect this to their oscillator detune, so it is handed out rather
    // than wired into the rack.
    vibrato,
    nodes: { chorusWet, flangeWet, vibrato, vibratoLfo, tremolo, tremoloDepth, tremoloLfo, delay, delayWet, feedback, reverb, reverbWet },
    reverbSeconds() { return reverbSeconds; },
    // Whether the convolver is in the graph at all, which is what it costs.
    reverbEngaged() { return reverbEngaged; },
    apply({ reverb: reverbOn, reverbMix = 0.35, reverbTime = REVERB_SECONDS.default, delay: delayTime, chorus, flanger,
      vibrato: vibratoDepth, tremolo: tremoloRate, bpm }) {
      const beat = 60 / (bpm || 120);

      // Up to fully wet: at 0.32 it was too polite to hear on a pad.
      const wet = reverbOn ? Math.max(0, Math.min(1.2, reverbMix)) : 0;
      if (wet > 0) engageReverb(true);
      setReverbSeconds(reverbTime, wet);
      ramp(reverbWet.gain, wet, ctx);
      if (wet === 0) engageReverb(false);
      ramp(chorusWet.gain, chorus ? 0.5 : 0, ctx);
      ramp(flangeWet.gain, flanger ? 0.55 : 0, ctx);
      ramp(vibrato.gain, VIBRATO_CENTS[vibratoDepth] || 0, ctx);

      const division = DELAY_DIVISIONS[delayTime] || 0;
      ramp(delayWet.gain, division ? 0.3 : 0, ctx);
      // The delay line itself is moved slowly: a jump in the time re-reads the
      // buffer from somewhere else, which is a tear rather than a click.
      if (division) ramp(delay.delayTime, Math.min(1.9, beat * division), ctx, 0.06);

      const rate = TREMOLO_DIVISIONS[tremoloRate] || 0;
      ramp(tremoloDepth.gain, rate ? 0.45 : 0, ctx);
      if (rate) ramp(tremoloLfo.frequency, rate / beat, ctx);
    },
  };
}
