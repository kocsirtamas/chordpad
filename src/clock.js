// The transport. Every musical timer in chordpad subscribes here; nothing else
// creates one. setTimeout alone drifts audibly on a phone, so steps are handed
// out with exact audio-clock times and scheduled ahead of the playhead.

const PUMP_INTERVAL_MS = 25;
const MAX_STEPS_PER_PUMP = 32;

// The pump has to keep running when the window is not the one being looked at.
// A page's own timers are throttled there, down to about once a second and
// sometimes less, which leaves the scheduler with nothing to hand the audio
// thread. A worker's timer is not throttled the same way, so the ticking is
// done there and the scheduling here. This is the standard answer to the
// problem and the only one available without a secure context: AudioWorklet,
// which would be better still, does not exist over plain HTTP.
const TICKER = `
let timer = null;
onmessage = (event) => {
  if (event.data.start !== undefined) {
    clearInterval(timer);
    timer = setInterval(() => postMessage('tick'), event.data.start);
  } else {
    clearInterval(timer);
    timer = null;
  }
};
`;

function createTicker(onTick) {
  // A worker, when the browser has one and will build it from a blob.
  if (typeof Worker === 'function' && typeof Blob === 'function' && typeof URL !== 'undefined') {
    try {
      const url = URL.createObjectURL(new Blob([TICKER], { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = onTick;
      return {
        kind: 'worker',
        start() { worker.postMessage({ start: PUMP_INTERVAL_MS }); },
        stop() { worker.postMessage({ stop: true }); },
      };
    } catch {
      // Fall through to the timer below.
    }
  }
  let timer = null;
  return {
    kind: 'timer',
    start() {
      if (timer !== null || typeof setInterval !== 'function') return;
      timer = setInterval(onTick, PUMP_INTERVAL_MS);
      // Under node a live interval keeps the process open, which turns a
      // failing test into a hang. Browsers have no unref and do not need one.
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

export function createClock({ getTime, lookahead = 0.1, subdivision = 4 } = {}) {
  const listeners = new Set();
  let bpm = 120;
  let running = false;
  let nextStep = 0;
  let nextTime = 0;
  let horizonSeconds = lookahead;
  let dropped = 0;
  // Diagnostics: the longest the pump has ever gone without running, which is
  // the thing that decides whether a gap is heard.
  let lastPump = null;
  let worstGap = 0;
  const ticker = createTicker(() => pump());

  function stepDuration() {
    return 60 / bpm / subdivision;
  }

  function emit(step, time) {
    for (const fn of listeners) {
      try { fn({ step, time }); } catch (err) { console.error(err); }
    }
  }

  function pump() {
    if (!running) return;
    const now = getTime();
    if (lastPump !== null) worstGap = Math.max(worstGap, now - lastPump);
    lastPump = now;

    // Browsers throttle timers in a window that is not on top, down to about
    // once a second. The pump then wakes to find the whole lookahead gone by,
    // and scheduling those steps anyway asks the audio thread to play a second
    // of music at once: a burst of overlapping notes, heard as a crack, and the
    // loop lurching back into place afterwards. A transport cannot play the
    // past, so the steps that went by while nothing was scheduling are counted
    // and dropped, and the transport picks up on the next step that is still
    // ahead. The loop keeps its place in the bar; it simply misses the part
    // nobody could have heard.
    if (nextTime < now) {
      const behind = Math.ceil((now - nextTime) / stepDuration());
      nextStep += behind;
      nextTime += behind * stepDuration();
      dropped += behind;
    }

    // Capped: widening the horizon, or a tempo dropping, must never make one
    // pump build a minute of music in a single go. Whatever is left over is
    // built by the next pump, twenty five milliseconds later.
    const horizon = now + horizonSeconds;
    let emitted = 0;
    while (nextTime < horizon && emitted < MAX_STEPS_PER_PUMP) {
      emit(nextStep, nextTime);
      nextStep += 1;
      nextTime += stepDuration();
      emitted += 1;
    }
  }

  return {
    stepDuration,
    setBpm(next) { bpm = next; },
    // How far ahead of the playhead to schedule. Small while the window is on
    // top, so a tempo change is heard at once; long once it is hidden, since
    // the pump may only run once a second there and everything it does not
    // schedule is silence.
    setLookahead(seconds) { horizonSeconds = Math.max(0.02, seconds); },
    getLookahead() { return horizonSeconds; },
    // How many steps have been given up because nothing scheduled them in time.
    droppedSteps() { return dropped; },
    getBpm() { return bpm; },
    isRunning() { return running; },
    onStep(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start(atTime = getTime()) {
      if (running) return;
      running = true;
      // The counter carries on from where it stopped, rounded up to the next
      // bar. It used to go back to zero, which put every step read while the
      // transport was stopped in the future of the run that followed: the
      // looper then measured a take against a step that no longer existed and
      // made a loop one step long. Continuing keeps every step comparable with
      // every other, and rounding up keeps a pattern starting on a downbeat.
      const bar = subdivision * 4;
      nextStep = Math.ceil(nextStep / bar) * bar;
      nextTime = atTime;
      lastPump = null;
      ticker.start();
    },
    stop() {
      running = false;
      lastPump = null;
      ticker.stop();
    },
    // What the transport has had to put up with: how it is being ticked, the
    // longest it went unpumped, and how many steps that cost.
    stats() {
      return { ticker: ticker.kind, worstGap: Math.round(worstGap * 1000), dropped };
    },
    pump,
  };
}
