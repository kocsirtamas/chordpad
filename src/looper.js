// An event looper, not an audio recorder. Each track is a list of the sounds the
// engine made, with the step they landed on and how long they lasted, so a track
// costs a few hundred bytes rather than seconds of audio. A take carries the
// settings it was played with, which is what keeps a pad overdub and a pluck
// overdub distinct; the mixer can set a track live instead, and then it follows
// whatever the panel says now.
//
// Recording quantises to the transport's step, which is a sixteenth note. That
// is a deliberate simplification: it keeps loops in time with the drums and the
// arpeggiator for free.

export const LOOPER_OFF = 'off';
export const LOOPER_COUNTING = 'counting';
export const LOOPER_ARMED = 'armed';
export const LOOPER_RECORDING = 'recording';
export const LOOPER_PLAYING = 'playing';
export const LOOPER_STOPPED = 'stopped';


// Follows the conventions looper pedals settled on: one control cycles record,
// play and overdub; stop and clear are different things, because stopping must
// not throw the take away; and undo removes the last layer. The one convention
// deliberately not copied is double tap to stop, since a double tap is
// unreliable with other fingers on the glass.
//
// The loop ends where recording ended. Not at the end of the bar, and not when
// the last note has finished fading: ending a take is the downbeat, and a tail
// still ringing plays over the top of the loop starting again, the way it does
// on a pedal.
// Four beats of count-in, which is the one every drummer gives.
const COUNT_IN_STEPS = 16;

export function createLooper({ clock, onEvent, onChange, soundingNow = () => [] }) {
  let mode = LOOPER_OFF;
  let tracks = [];
  let pending = new Map();
  let originStep = 0;
  let length = 0;
  let current = null;
  // The take starts at the first note played, not when the button was pressed,
  // and ends at the last release, so arming early or stopping late does not
  // record silence at either end.
  let started = false;
  let lastActivity = 0;
  // Where the count-in began, in transport steps, and null until the transport
  // says so. The step handed in with a button press cannot be used for this: the
  // clock restarts its counter from zero every time it starts, so a step read
  // while it was stopped belongs to a count that no longer exists. Everything
  // that has to line up with the transport is anchored on a step the transport
  // itself handed us.
  let countFrom = null;
  // Set when a bounced track arrives while nothing was playing, for the same
  // reason: the loop can only be anchored once the transport is running.
  let anchorPending = false;

  // Levels a track can be set to. A handful of steps rather than a slider: a
  // fader per track is not usable with a thumb on a phone.
  const LEVELS = [1, 0.6, 0.3];

  function mix() {
    return tracks.map(track => ({ muted: track.muted, level: track.level, live: track.live }));
  }

  function notify() {
    if (onChange) onChange({ mode, tracks: tracks.length, length, mix: mix() });
  }

  // A take that begins while chords are already being held takes them with it.
  // They announced their start before recording did, so there is nothing to
  // hear from them until they are released, and the take would otherwise begin
  // with the silence of a chord that is plainly sounding. This is the live
  // case: holding something worth keeping, then reaching for record.
  function adoptHeld(step) {
    for (const held of soundingNow()) {
      if (pending.has(held.id)) continue;
      pending.set(held.id, { at: stepNow(step), payload: { notes: held.notes, opts: held.opts } });
    }
  }

  function closeTake(endStep) {
    const firstTake = length === 0;
    // The take is as long as the recording was: from the first note to the
    // moment the button ended it. Measuring to the last note instead let the
    // loop run on while a chord faded, which is heard as a pause before it
    // starts again.
    const endedAt = endStep === undefined ? lastActivity : endStep;

    // Chords still being held when the take ends are written down as lasting to
    // the end of it. They have announced no stop, and dropping them would lose
    // exactly the chord somebody was holding while they pressed the button.
    if (current) {
      for (const [id, from] of pending) {
        current.push({
          at: from.at,
          steps: Math.max(1, stepNow(endedAt) - from.at),
          payload: from.payload,
        });
        pending.delete(id);
      }
    }

    if (firstTake) length = Math.max(1, endedAt - originStep);
    if (current && current.length) tracks.push({ events: current, muted: false, level: 1, live: false });
    current = null;

    // Playback counted on from wherever recording began, so ending a take part
    // way through started the loop part way through itself. Moving the origin
    // to the moment the take ends puts the playhead at the top of the loop, so
    // it always begins at the beginning. Only for the first take: an overdub is
    // aligned to the loop that already exists.
    // The step handed in here is the last one the clock emitted, and the clock
    // emits ahead of the playhead, so that step is already gone. The next one is
    // where the loop can actually begin.
    if (firstTake && endStep !== undefined) originStep = endStep + 1;
  }

  function stepNow(step) {
    return length > 0 ? ((step - originStep) % length + length) % length : step - originStep;
  }

  return {
    state() {
      return { mode, tracks: tracks.length, length, mix: mix() };
    },

    // The mixer. A muted track keeps its events: muting is not undo.
    toggleMute(index) {
      const track = tracks[index];
      if (!track) return;
      track.muted = !track.muted;
      notify();
    },

    // A take carries the sound it was played with, which is what lets a pad
    // overdub and a pluck overdub stay a pad and a pluck. Turned live, it
    // follows the panel instead, so a loop can be re-voiced while it plays.
    toggleLive(index) {
      const track = tracks[index];
      if (!track) return;
      track.live = !track.live;
      notify();
    },

    // Cycles the track through the levels on offer, which is one control rather
    // than two and reads the same on a phone as on a desktop.
    cycleLevel(index) {
      const track = tracks[index];
      if (!track) return;
      track.level = LEVELS[(LEVELS.indexOf(track.level) + 1) % LEVELS.length];
      notify();
    },

    mix,
    // What was actually written down. Used by the ?debug=1 build and by tests
    // that need to see a take rather than listen to it.
    takes() {
      return tracks.map(track => track.events.map(event => ({
        at: event.at,
        steps: event.steps,
        notes: event.payload.notes || event.payload.drum,
      })));
    },
    trackCount() { return tracks.length; },
    loopLength() { return length; },

    // One control, cycled: arm, then record, then play, then clear. With a
    // count-in it waits four beats first, and then records from the downbeat
    // whether or not anything has been played: that is what the count is for.
    toggle(step = 0, { countIn = false } = {}) {
      if (mode === LOOPER_OFF) {
        mode = countIn ? LOOPER_COUNTING : LOOPER_ARMED;
        countFrom = null;
        originStep = step;
        started = false;
        lastActivity = step;
        current = [];
        // Armed with chords already sounding: there is nothing to wait for, so
        // the take starts here rather than at the next key press. A count-in is
        // a deliberate wait, so it still counts.
        if (!countIn && soundingNow().length > 0) {
          mode = LOOPER_RECORDING;
          started = true;
          adoptHeld(step);
        }
      } else if (mode === LOOPER_COUNTING) {
        // Pressed again during the count: the count is called off.
        mode = LOOPER_OFF;
        current = null;
        countFrom = null;
      } else if (mode === LOOPER_ARMED || mode === LOOPER_RECORDING) {
        closeTake(step);
        mode = tracks.length ? LOOPER_PLAYING : LOOPER_OFF;
      } else if (mode === LOOPER_PLAYING || mode === LOOPER_STOPPED) {
        // Recording another layer over what is already looping. The length is
        // already fixed, so this take is measured against the existing loop.
        mode = LOOPER_RECORDING;
        started = true;
        current = [];
        adoptHeld(step);
      }
      notify();
      return mode;
    },

    // Stops playback without throwing anything away, which is the distinction
    // every looper pedal makes and the thing that was missing here.
    stop() {
      if (mode === LOOPER_COUNTING) {
        mode = tracks.length ? LOOPER_STOPPED : LOOPER_OFF;
        current = null;
        countFrom = null;
        notify();
        return mode;
      }
      if (mode === LOOPER_RECORDING || mode === LOOPER_ARMED) closeTake(undefined);
      mode = tracks.length ? LOOPER_STOPPED : LOOPER_OFF;
      notify();
      return mode;
    },

    play() {
      if (tracks.length) mode = LOOPER_PLAYING;
      notify();
      return mode;
    },

    // Removes the most recent layer, the way holding record does on a pedal.
    undo() {
      if (mode === LOOPER_RECORDING || mode === LOOPER_ARMED) {
        current = null;
        mode = tracks.length ? LOOPER_PLAYING : LOOPER_OFF;
        notify();
        return mode;
      }
      tracks.pop();
      if (tracks.length === 0) {
        length = 0;
        mode = LOOPER_OFF;
      }
      notify();
      return mode;
    },

    clear() {
      mode = LOOPER_OFF;
      tracks = [];
      pending = new Map();
      current = null;
      length = 0;
      originStep = 0;
      started = false;
      lastActivity = 0;
      countFrom = null;
      anchorPending = false;
      notify();
    },

    // Fed straight from the engine: every sound it makes is announced with the
    // exact notes and settings used, so a take is what was heard, whatever mode
    // or control produced it. Nothing here knows about chords or modes.
    record(event, step, stepDuration) {
      // Nothing played during the count belongs to the take.
      if (mode !== LOOPER_ARMED && mode !== LOOPER_RECORDING) return;

      if (event.kind === 'stop') {
        const from = pending.get(event.id);
        if (!from) return;
        pending.delete(event.id);
        lastActivity = step;
        if (current) {
          current.push({
            at: from.at,
            steps: Math.max(1, stepNow(step) - from.at),
            payload: { ...from.payload, opts: { ...from.payload.opts, release: event.release } },
          });
        }
        return;
      }

      if (mode === LOOPER_ARMED) {
        mode = LOOPER_RECORDING;
        notify();
      }
      if (!started) {
        started = true;
        originStep = step;
      }
      lastActivity = step;

      if (event.kind === 'start') {
        pending.set(event.id, { at: stepNow(step), payload: { notes: event.notes, opts: event.opts } });
        return;
      }
      if (!current) return;
      if (event.kind === 'strike') {
        // Not rounded to a whole step: repeat gates the chord for six tenths of
        // one, and rounding that up to a full step made playback less gappy than
        // what was played.
        const steps = Math.max(0.05, event.duration / Math.max(0.0001, stepDuration));
        current.push({ at: stepNow(step), steps, payload: { notes: event.notes, opts: event.opts } });
      } else if (event.kind === 'drum') {
        current.push({ at: stepNow(step), steps: 1, payload: { drum: event.drum, kit: event.kit } });
      }
    },

    // Kept for the tests that describe the recording rules directly.
    noteOn(key, payload, step) {
      if (mode !== LOOPER_ARMED && mode !== LOOPER_RECORDING) return;
      if (mode === LOOPER_ARMED) {
        mode = LOOPER_RECORDING;
        notify();
      }
      if (!started) {
        started = true;
        originStep = step;
      }
      lastActivity = step;
      pending.set(key, { at: stepNow(step), payload });
    },

    // A drum hit has no length worth recording: it is a strike, not a hold.
    hit(payload, step) {
      if (mode !== LOOPER_ARMED && mode !== LOOPER_RECORDING) return;
      if (mode === LOOPER_ARMED) {
        mode = LOOPER_RECORDING;
        notify();
      }
      if (!started) {
        started = true;
        originStep = step;
      }
      lastActivity = step;
      if (current) current.push({ at: stepNow(step), duration: 1, payload });
    },

    noteOff(key, step) {
      if (!pending.has(key)) return;
      const from = pending.get(key);
      pending.delete(key);
      lastActivity = step;
      if (!current) return;
      current.push({
        at: from.at,
        duration: Math.max(1, stepNow(step) - from.at),
        payload: from.payload,
      });
    },

    // A pattern that was played by something other than fingers: the sequencer
    // or the drum machine, bounced down to a track on the way out of that mode.
    addTrack(events, steps, step = 0) {
      if (!events || events.length === 0 || steps <= 0) return false;
      if (length === 0) {
        length = steps;
        originStep = step;
        // The transport may not have run since this step was read, so the loop
        // is anchored again on the next one it actually emits.
        anchorPending = true;
      }
      tracks.push({ events, muted: false, level: 1, live: false });
      if (mode === LOOPER_OFF) mode = LOOPER_PLAYING;
      notify();
      return true;
    },

    // Driven by the transport: replays whatever was recorded for this step.
    onStep({ step, time }) {
      if (anchorPending) {
        anchorPending = false;
        originStep = step;
      }

      if (mode === LOOPER_COUNTING) {
        // The count starts on a beat, so four clicks are heard rather than
        // however many happen to fall between here and the end of the count.
        // A counter that has gone backwards means the transport restarted, and
        // the count starts again from here rather than never arriving.
        if (countFrom === null || step < countFrom) {
          if (step % 4 === 0) countFrom = step;
        } else if (step - countFrom >= COUNT_IN_STEPS) {
          // The count is over: recording starts on the downbeat, played or not.
          mode = LOOPER_RECORDING;
          started = true;
          originStep = step;
          lastActivity = step;
          countFrom = null;
          // Whatever is being held as the count ends is part of the take.
          adoptHeld(step);
          notify();
        }
      }
      if (mode === LOOPER_STOPPED || tracks.length === 0 || length === 0) return;
      const position = stepNow(step);
      for (const track of tracks) {
        if (track.muted) continue;
        for (const event of track.events) {
          if (event.at === position) {
            onEvent(event, time, clock.stepDuration(), { level: track.level, live: track.live });
          }
        }
      }
    },
  };
}
