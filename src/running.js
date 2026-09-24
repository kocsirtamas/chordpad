// Whether the transport is running, and why.
//
// It normally runs only when something needs it, so that nothing ticks while
// somebody is playing plain chords. Seven things can need it, which is six more
// than anybody can keep track of while playing, so the reason is given in words
// rather than left to be worked out.
//
// It can also be turned on and off by hand, by tapping the lamps. On is worth
// having because watching the beat go round is a reason on its own: it is how
// anybody works out where the bar is before recording into it. Off is worth
// having because a leftover setting can leave it running with nothing to show.
//
// No DOM here, and no clock: this is the decision, and it is the part worth
// being sure about.

import { isClocked, MODES } from './modes.js';
import { LOOPER_OFF, LOOPER_COUNTING, LOOPER_RECORDING } from './looper.js';

// Everything that can keep it running, in the order worth telling somebody
// about: the most specific answer first.
const REASONS = [
  { id: 'mode', applies: s => isClocked(s.mode),
    label: s => `${MODES[s.mode] ? MODES[s.mode].label : s.mode} mode` },
  { id: 'looper', applies: s => Boolean(s.looper) && s.looper.mode !== LOOPER_OFF,
    label: () => 'the looper' },
  { id: 'beat', applies: s => s.beat !== 'off', label: () => 'the drum pattern' },
  { id: 'autodrum', applies: s => s.autoDrum !== 'off', label: () => 'auto drum' },
  { id: 'metronome', applies: s => Boolean(s.metronome), label: () => 'the metronome' },
  { id: 'sampler', applies: s => s.samplerBars > 0, label: () => 'the sampler, counting bars' },
  { id: 'pending', applies: s => Object.keys(s.pending || {}).length > 0,
    label: () => 'a change waiting for the downbeat' },
];

// What would keep it running on its own, in the words somebody would use, or
// nothing if it would stop.
export function whatNeedsIt(s) {
  const found = REASONS.find(reason => reason.applies(s));
  return found ? found.label(s) : null;
}

// Every one of them that applies, not only the one worth saying. Two states
// with the same list are the same question, however differently they are
// worded: a drum pattern added while the metronome was already running changes
// which answer is given and not what was asked.
export function needsList(s) {
  return REASONS.filter(reason => reason.applies(s)).map(reason => reason.id);
}

// Whether stopping now would lose a take. A looper that is counting in or
// recording is measuring against the transport, and a transport that stops
// under it leaves the take with no end: it would sit in recording for ever with
// nothing to finish it.
export function takeInProgress(s) {
  const mode = s.looper && s.looper.mode;
  return mode === LOOPER_COUNTING || mode === LOOPER_RECORDING;
}

// The answer: a reason it is running, or null if it should stop.
export function whyRunning(s) {
  const needed = whatNeedsIt(s);
  if (s.transport === 'off') {
    // Everything gives way to being switched off except a take that would be
    // stranded by it.
    return takeInProgress(s) ? 'the looper, mid take' : null;
  }
  if (s.transport === 'on') return needed || 'you asked to see the beat';
  return needed;
}

// Whether a switch by hand should be forgotten. Once what the instrument itself
// needs has changed, the hand's answer was to a different question: leaving it
// standing means selecting a drum pattern and hearing nothing, which reads as
// the app being broken rather than as an earlier decision being honoured.
export function forgetSwitch(previous, s) {
  if (!s.transport || s.transport === 'auto') return false;
  if (!previous) return false;
  return needsList(previous).join() !== needsList(s).join();
}

// What tapping the lamps does: stop it if it is running, start it if not.
export function tapped(s) {
  return whyRunning(s) ? 'off' : 'on';
}
