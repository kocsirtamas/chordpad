// The vocoder's analysis, as text, so that the same lines run inside the audio
// worklet and inside the tests. Nothing here touches Web Audio: it is a bank of
// filters and envelope followers over a block of samples, which is exactly the
// part worth testing on its own.
//
// It is a worklet rather than a graph of nodes because the two things that make
// speech legible cannot be built from nodes. An envelope follower needs a fast
// attack and a slow release, and a node can only be given one time constant for
// both; and smoothing a rectified band needs a real lowpass, where the only
// feedback a graph allows is a delay of a whole render quantum, which is a comb
// and not a lowpass at all. Measured, that comb passed the ripple of the
// rectifier straight through to the gain it was driving, which is heard as
// crackling and got worse the shorter the release was set.
//
// The microphone needs a secure context and so does a worklet, so wherever
// there is anything to vocode, this can run.

export const DSP = `
// How loud the voice is taken to be once its distance from the microphone has
// been divided out, and how much of that division is allowed. One measurement
// for the whole voice rather than one per band: dividing each band by the total
// takes the syllables out along with the distance, and the syllables are the
// words. Measured, per band division scored 0.20 on how well the chords followed
// the voice where a vocoder should score past 0.7.
const TARGET = 0.08;
const MAX_BOOST = 40;
const QUIET = 0.0004;

// Where a band stops opening in step with the voice and starts easing towards
// fully open instead.
const KNEE = 0.7;

// What a gate of one would stand at, as a raw microphone level. Measured from
// the fixtures: a sentence a hand's width away tracks at about 0.010, the same
// sentence twenty decibels back at about 0.0010, and a quiet room at about
// 0.0006. So the default of 0.02 stands at 0.001, between the room and the
// furthest away anybody is going to be, and the control covers both sides of it.
const GATE_SCALE = 0.05;

// How quickly the distance measurement moves. Slow, since distance is not
// something that changes within a word, but not so slow that walking towards
// the microphone takes a bar to catch up.
const LEVEL_UP = 0.15;
const LEVEL_DOWN = 0.6;

class BandBank {
  constructor(rate, centres, settings) {
    this.rate = rate;
    this.centres = centres;
    const n = centres.length;
    this.n = n;
    this.x1 = new Float64Array(n);
    this.x2 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.y2 = new Float64Array(n);
    this.b0 = new Float64Array(n);
    this.b2 = new Float64Array(n);
    this.a1 = new Float64Array(n);
    this.a2 = new Float64Array(n);
    this.env = new Float64Array(n);
    this.tilt = new Float64Array(n);
    this.level = 0;
    this.open = false;
    this.gateGain = 0;
    this.settings = {};
    this.set(settings || {});
  }

  set(next) {
    const s = Object.assign({}, this.settings, next);
    this.settings = s;
    const q = Math.max(0.3, Math.min(40, s.q || 3.7));
    for (let i = 0; i < this.n; i++) {
      const w0 = 2 * Math.PI * Math.min(this.centres[i], this.rate * 0.45) / this.rate;
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      // A bandpass with unity gain at its centre, so a band's reading is the
      // loudness of the voice there and not of the filter.
      this.b0[i] = alpha / a0;
      this.b2[i] = -alpha / a0;
      this.a1[i] = -2 * Math.cos(w0) / a0;
      this.a2[i] = (1 - alpha) / a0;
      this.tilt[i] = (s.tilt && s.tilt[i]) || 1;
    }
    const step = t => Math.exp(-1 / (this.rate * Math.max(t, 1 / this.rate)));
    // Fast up, slow down. A consonant is a few milliseconds of noise and a
    // vowel is a tenth of a second of tone: one time constant for both turns
    // every consonant into the front of the vowel after it, which is most of
    // what makes a word a word.
    this.attack = step(s.attack === undefined ? 0.003 : s.attack);
    this.release = step(s.release === undefined ? 0.025 : s.release);
    this.gate = s.gate === undefined ? 0.02 : s.gate;
    this.drive = s.drive === undefined ? 1.5 : s.drive;
    this.contrast = s.contrast === undefined ? 1 : s.contrast;
    // How quickly the room measurement is allowed to move the output. Slow on
    // the way down, so a voice sitting near the threshold does not chatter.
    this.gateOpen = 1 / (this.rate * 0.002);
    this.gateShut = 1 / (this.rate * 0.08);
    // How hard the room is pushed down under the threshold. Gentle: measured on
    // real recordings, squaring scored 0.49 on how well the chords followed the
    // voice and this scores 0.71, because a steep slope bends the quiet half of
    // every word out of shape on its way down.
    this.expand = s.expand === undefined ? 0.5 : s.expand;
  }

  // Fills one control signal per band for this block of input.
  run(input, out, frames) {
    const n = this.n;
    for (let i = 0; i < frames; i++) {
      const x = input ? input[i] : 0;
      const a = x < 0 ? -x : x;
      // How far away the voice is, as one number for the whole of it.
      const coef = a > this.level ? LEVEL_UP : LEVEL_DOWN;
      this.level += (a - this.level) * coef / this.rate * 20;
      const boost = Math.min(MAX_BOOST, TARGET / Math.max(this.level, QUIET));
      const s = x * boost;

      // Not a gate: below the threshold the room is pushed down rather than
      // cut off. A gate that shuts takes the quiet half of speech with it, and
      // the quiet half of speech is where the consonants and the ends of words
      // are. Measured on a real recording, a threshold sitting at the middle of
      // the voice scored 0.24 on how well the chords followed it, against 0.81
      // with the gate out of the way entirely: this keeps the second number and
      // still puts a room thirty decibels down forty decibels down.
      //
      // Judged before the distance is divided out, since dividing it out is
      // what makes a quiet room and a spoken word the same size.
      const over = this.level / (this.gate * GATE_SCALE + 1e-9);
      const wanted = over >= 1 ? 1 : Math.pow(over, this.expand);
      // Quick to let a sound in and slow to push it back down, like the bands
      // themselves: at one speed for both, the first thirty milliseconds of
      // every word arrived faded up, which is where the plosives are.
      this.gateGain += (wanted - this.gateGain)
        * (wanted > this.gateGain ? this.gateOpen : this.gateShut);

      for (let b = 0; b < n; b++) {
        const y = this.b0[b] * s + this.b2[b] * this.x2[b]
          - this.a1[b] * this.y1[b] - this.a2[b] * this.y2[b];
        this.x2[b] = this.x1[b];
        this.x1[b] = s;
        this.y2[b] = this.y1[b];
        this.y1[b] = y;

        const rectified = y < 0 ? -y : y;
        const c = rectified > this.env[b] ? this.attack : this.release;
        this.env[b] = rectified + (this.env[b] - rectified) * c;
        // How loud this band is against how loud speech usually is there.
        // Letting each band learn its own average instead sounded like the
        // right idea and measured plainly worse, 0.36 against 0.62: what it
        // divides out along with the shape of the voice is the rise and fall
        // between syllables, and that rise and fall is most of the words.
        const ratio = this.env[b] * this.tilt[b] * this.drive;
        // Straight through until it nears the top, then bent so it approaches
        // fully open without arriving. Bending the whole range instead cost the
        // loud bands their detail, which is where the consonants are: measured,
        // a soft curve all the way scored 0.50 on how well the chords followed
        // the voice against 0.69 for this.
        let open = ratio <= KNEE ? ratio : 1 - (1 - KNEE) * (1 - KNEE) / (ratio - KNEE + 1 - KNEE);
        if (this.contrast !== 1) open = Math.pow(open, this.contrast);
        out[b][i] = open * this.gateGain;
      }
    }
  }
}
`;

export const WORKLET = `${DSP}
class VocoderAnalysis extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.bank = new BandBank(sampleRate, o.centres || [], o.settings || {});
    this.port.onmessage = event => this.bank.set(event.data || {});
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const out = outputs[0];
    const frames = out[0] ? out[0].length : 128;
    this.bank.run(input, out, frames);
    return true;
  }
}
registerProcessor('vocoder-analysis', VocoderAnalysis);
`;

// The same class, for tests and for measuring offline.
export function createBandBank(rate, centres, settings) {
  const Bank = new Function(`${DSP}\nreturn BandBank;`)();
  return new Bank(rate, centres, settings);
}
