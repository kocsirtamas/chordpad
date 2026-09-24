// Translates pointer intent into state changes and engine calls. Holds the
// per-pointer voice sets, so every feature after this one can ask "what is held"
// rather than "what is the one active chord".

import { voicing } from './theory.js';
import { isClocked, isDrums, isSequencer, arpOrder, notesForPress, holdsChord, STRUM_SPEEDS } from './modes.js';
import { createSequencer, STEPS_PER_CHORD } from './sequencer.js';
import { DRUM_MAP } from './audio/drums.js';
import { hitsAt, STEPS_PER_PATTERN } from './audio/patterns.js';
import { autoDrumOffsets } from './audio/autodrum.js';
import { VOICE_CATEGORIES, THEORY_CATEGORIES, merge, revoices, snapshotTheory } from './loopfx.js';
import { offsetsAt, stepsPerHit } from './rates.js';

const REBUILD_RELEASE = 0.08;

export function createInput({ state, engine, modifiers, clock, onChord = null }) {
  const sequencer = createSequencer();
  // What is being held, by key rather than by finger: one key is one chord
  // however many things are pressing it. Each entry knows which of them are,
  // so letting go of the keyboard while the mouse is still down hands the note
  // over rather than ending it.
  const heldPointers = new Map();
  const holderOf = new Map();

  function holdersFor(entry) {
    return entry.holders;
  }

  function entryFor(pointerId) {
    const degreeIndex = holderOf.get(pointerId);
    return degreeIndex === undefined ? null : heldPointers.get(degreeIndex) || null;
  }

  function addHolder(entry, pointerId) {
    entry.holders.add(pointerId);
    holderOf.set(pointerId, entry.degreeIndex);
  }

  // Returns true when that was the last thing holding the key down.
  function dropHolder(entry, pointerId) {
    holderOf.delete(pointerId);
    entry.holders.delete(pointerId);
    return entry.holders.size === 0;
  }

  function forget(entry) {
    for (const id of entry.holders) holderOf.delete(id);
    heldPointers.delete(entry.degreeIndex);
  }

  // Remembered so voice leading has something to move away from.
  let previousNotes = null;

  // A key may carry its own octave and its own locked modifiers, which take the
  // place of whatever the modifier pad currently says.
  function settingsForKey(s, degreeIndex) {
    const per = (s.perKey && s.perKey[degreeIndex]) || { octave: 0, lock: null };
    return {
      mods: per.lock ? new Set(per.lock) : modifiers.active(),
      octave: s.baseOctave + (per.octave || 0),
    };
  }

  function notesFor(degreeIndex, { remember = false } = {}) {
    const s = state.get();
    const per = settingsForKey(s, degreeIndex);
    const notes = voicing(s.keyRoot, degreeIndex, per.mods, per.octave, s.scale, {
      inversion: s.inversion,
      voiceLeading: s.voiceLeading,
      bass: s.bass,
      previous: previousNotes,
    });
    if (remember) previousNotes = notes;
    return notes;
  }

  // Everything the engine needs to shape a sound, gathered in one place so a new
  // setting reaches live chords, the arpeggiator, the sequencer and the looper
  // without being threaded through each of them by hand.
  function soundOpts(s) {
    return {
      instrument: s.instrument,
      cutoff: s.cutoff,
      adsr: s.adsr,
      stereo: s.stereo,
      voices: s.voices,
      // Only the microphone's own sample is played back as it was recorded;
      // every other instrument is played, not replayed.
      raw: s.instrument === 'mic' && Boolean(s.samplerRaw),
      loop: s.instrument === 'mic' && Boolean(s.samplerLoop),
    };
  }

  // Glide slides the oscillators to the new chord instead of restarting them,
  // so one chord becomes the next rather than replacing it.
  const GLIDE_SECONDS = { off: 0, slow: 0.35, fast: 0.06 };
  function glideSeconds(s) { return GLIDE_SECONDS[s.glide] || 0; }

  // Where a chord came from, recorded alongside the notes so a loop can be
  // built again in another key rather than only replayed as the pitches it was.
  function originOf(s, degreeIndex) {
    return {
      origin: { degreeIndex, mods: [...settingsForKey(s, degreeIndex).mods] },
      theory: snapshotTheory(s),
    };
  }

  function voicesFor(degreeIndex) {
    const s = state.get();
    // A clocked mode makes no sound on the press itself: the transport does it.
    // Unless the arpeggiator is holding the chord underneath itself, which is
    // the whole difference between arp only and chord+arp.
    if (isClocked(s.mode) && !holdsChord(s.mode, s.arpChord)) return { voices: [], clocked: true };
    return engine.playChord(notesForPress(s.mode, notesFor(degreeIndex, { remember: true })), {
      ...soundOpts(s),
      ...originOf(s, degreeIndex),
      spread: s.mode === 'strum' ? (STRUM_SPEEDS[s.strumSpeed] || STRUM_SPEEDS.medium) : 0,
    });
  }

  // A plucked sound should not ring for the sustain slider's full length, so a
  // preset may cap it. The slider still shortens it further. One rule, used both
  // when a finger lifts and when the looper has to write down how a chord it
  // adopted would have faded.
  function releaseFor(set) {
    const sustain = state.get().sustain;
    return set && set.release !== undefined ? Math.min(sustain, set.release) : sustain;
  }

  // Chords that outlive the finger that started them: a drone, or anything held
  // while the hold lock is on. Keyed by degree, so pressing a lit key stops it.
  const sustained = new Map();

  function stopSustained(degreeIndex) {
    const set = sustained.get(degreeIndex);
    if (!set) return;
    sustained.delete(degreeIndex);
    engine.stopChord(set, state.get().sustain);
  }

  function stopAllSustained() {
    for (const degreeIndex of [...sustained.keys()]) stopSustained(degreeIndex);
    syncHeld();
  }

  // Only what fingers and keys are holding. A drone, or a chord the lock is
  // holding, is meant to outlive the hand: leaving the window is no reason to
  // end it, while a finger that was still down when the window went away is
  // plainly not down any more.
  function releaseHeld() {
    for (const entry of heldPointers.values()) {
      if (!entry.drum) engine.stopChord(entry.set, releaseFor(entry.set));
    }
    heldPointers.clear();
    holderOf.clear();
    syncHeld();
  }

  function releaseEverything() {
    stopAllSustained();
    for (const entry of heldPointers.values()) {
      if (!entry.drum) engine.stopChord(entry.set, releaseFor(entry.set));
    }
    heldPointers.clear();
    holderOf.clear();
    state.set({ held: [] });
  }

  // The arpeggiator and repeat are driven from the transport, so their timing
  // comes from the audio clock rather than from whenever a timer happens to run.
  // The transport's step counter, which the looper records against.
  let step = 0;
  function currentStep() { return step; }

  function onStep({ step: at, time }) {
    const s = state.get();

    // The backing beat runs whatever mode is selected, so a pattern can play
    // under chords rather than only in drum mode.
    if (s.beat && s.beat !== 'off') {
      for (const hit of hitsAt(s.beat, at, s.beatVariation)) {
        engine.strikeDrum(hit.drum, s.kit, time, { record: false, gain: hit.gain });
      }
    }

    // The sequencer plays from its own pattern rather than from what is held.
    if (isSequencer(s.mode)) {
      const due = sequencer.chordAt(at);
      if (!due) return;
      const notes = voicing(s.keyRoot, due.step.degreeIndex, new Set(due.step.mods),
        s.baseOctave, s.scale, { inversion: s.inversion, bass: s.bass });
      engine.strike(notes, {
        ...soundOpts(s),
        origin: { degreeIndex: due.step.degreeIndex, mods: [...due.step.mods] },
        theory: snapshotTheory(s),
      }, time, clock.stepDuration() * STEPS_PER_CHORD * 0.9);
      state.set({ sequenceAt: due.index });
      return;
    }

    // A held drum key repeats itself, at a rate that need not land on the grid.
    if (isDrums(s.mode) && s.autoDrum !== 'off') {
      const stepSeconds = clock.stepDuration();
      for (const entry of heldPointers.values()) {
        if (!entry.drum) continue;
        for (const offset of autoDrumOffsets(s.autoDrum, at, stepSeconds)) {
          engine.strikeDrum(entry.drum, s.kit, time + offset);
        }
      }
      return;
    }

    if (!isClocked(s.mode) || heldPointers.size === 0) return;
    const duration = clock.stepDuration();
    // Both clocked modes run at the chosen rate, which is why they share a
    // control: a shuffle is a shuffle whether it is arpeggiated or gated.
    const offsets = offsetsAt(s.arpRate, at, duration);
    const noteLength = stepsPerHit(s.arpRate) * duration;

    for (const entry of heldPointers.values()) {
      const notes = notesFor(entry.degreeIndex);
      const opts = soundOpts(s);

      // rhythm+arp gates the whole chord on the beat under the arpeggio, which
      // is what makes it a rhythm rather than a pad.
      if (s.mode === 'arpeggio' && s.arpChord === 'rhythm' && at % 4 === 0) {
        engine.strike(notes, opts, time, duration * 2);
      }

      for (const offset of offsets) {
        if (s.mode === 'arpeggio') {
          const order = arpOrder(notes, s.arpPattern);
          engine.strike([order[entry.step % order.length]], opts, time + offset, noteLength);
        } else {
          engine.strike(notes, opts, time + offset, noteLength * 0.6);
        }
        entry.step += 1;
      }
    }
  }

  if (clock) {
    clock.onStep(event => { step = event.step; });
    clock.onStep(onStep);
  }

  // A recorded event carries the notes and the settings they were sounded with,
  // so replaying is repeating an instruction rather than rebuilding a chord.
  // Nothing here has to know which mode or control produced it.
  function playRecorded(event, time, stepDuration, { level = 1, live = false } = {}) {
    const seconds = Math.max(0.05, (event.steps || 1) * stepDuration);
    const s = state.get();
    const follows = s.toLoop || {};
    if (event.payload.drum) {
      const kit = live || follows.instrument ? s.kit : event.payload.kit;
      const hit = event.payload.gain === undefined ? 1 : event.payload.gain;
      engine.strikeDrum(event.payload.drum, kit, time, { viaLoop: true, gain: level * hit });
      return;
    }

    // Category by category: the live setting where it is let through, and the
    // recorded one where it is not. A track the mixer has set live follows
    // everything. What belongs to the performance rather than to a setting, the
    // roll of a strum and the length of the fade, always stays as recorded.
    const recorded = event.payload.opts;
    const opts = {
      ...recorded,
      ...merge(VOICE_CATEGORIES, recorded, s, follows, live),
      spread: recorded.spread,
      release: recorded.release,
      viaLoop: true,
      level,
    };

    // Changing the key changes which notes the chord is, so it has to be built
    // again from the degree it was played on. Only a whole chord press carries
    // that: an arpeggio note is one note of one, and stays as it was recorded.
    const notes = revoices(follows, live) && recorded.origin && recorded.theory
      ? rebuild(recorded, merge(THEORY_CATEGORIES, recorded.theory, s, follows, live))
      : event.payload.notes;

    engine.strike(notes, opts, time, seconds);
  }

  function rebuild({ origin }, theory) {
    return voicing(theory.keyRoot, origin.degreeIndex, new Set(origin.mods),
      theory.baseOctave, theory.scale, {
        inversion: theory.inversion,
        bass: theory.bass,
        voiceLeading: theory.voiceLeading,
      });
  }


  function syncHeld() {
    const held = [...heldPointers.keys()];
    // A sustained chord is still sounding, so its key stays lit: otherwise there
    // is no way to see what is playing or which key will stop it.
    for (const degreeIndex of sustained.keys()) {
      if (!held.includes(degreeIndex)) held.push(degreeIndex);
    }
    state.set({ held });
  }

  // A tap on a modifier fires press then release, and both leave it active: on
  // press because it is held, on release because the tap latched it. Rebuilding
  // for the second one restarts a chord that did not change, which is heard as a
  // wobble. So rebuild only when the sounding set actually differs.
  function modifierFingerprint() {
    return [...modifiers.active()].sort().join(',');
  }

  function applyModifierChange(change) {
    const before = modifierFingerprint();
    change();
    syncMods();
    if (modifierFingerprint() !== before) rebuildAllHeld();
  }

  function syncMods() {
    state.set({
      latched: [...modifiers.latched()],
      momentary: [...modifiers.momentaryHeld()],
      mods: [...modifiers.active()],
    });
  }

  // A modifier changing mid-chord re-voices what is already sounding. Retuning
  // the existing voices is preferred: stopping and restarting overlaps a fading
  // chord with a new one, which is both louder and audibly a retrigger.
  function rebuildAllHeld({ force = false } = {}) {
    for (const entry of heldPointers.values()) {
      if (entry.drum) continue;
      // Retuning keeps the note sounding through the change. A different
      // instrument cannot be retuned into, so that one has to start again.
      if (!force && engine.retuneChord(entry.set, notesFor(entry.degreeIndex))) continue;
      engine.stopChord(entry.set, REBUILD_RELEASE);
      entry.set = voicesFor(entry.degreeIndex);
    }
    // A chord the lock is holding is still sounding, so a setting change has to
    // reach it too. Changing the sound with a finger down worked; changing it
    // with the lock holding the same chord did not.
    for (const [degreeIndex, set] of [...sustained.entries()]) {
      if (!force && engine.retuneChord(set, notesFor(degreeIndex))) continue;
      engine.stopChord(set, REBUILD_RELEASE);
      sustained.set(degreeIndex, voicesFor(degreeIndex));
    }
  }

  // The filter moves on the notes that are already sounding, so the tone slider
  // is heard immediately rather than only on the next chord.
  function applyTone() {
    const cutoff = state.get().cutoff;
    for (const entry of heldPointers.values()) if (!entry.drum) engine.setCutoff(entry.set, cutoff);
    for (const set of sustained.values()) engine.setCutoff(set, cutoff);
  }

  return {
    chordDown(degreeIndex, pointerId) {
      if (holderOf.has(pointerId)) return;
      // The same key can be reached by a finger, a mouse and the keyboard at
      // once. One key is one chord, however many things are pressing it: the
      // second press joins the first rather than sounding again or being
      // ignored, so a hand can move from the keyboard to the mouse mid note.
      const already = heldPointers.get(degreeIndex);
      if (already) {
        addHolder(already, pointerId);
        return;
      }
      const s = state.get();
      // Pressing a key that is still sounding on its own stops it, which is how
      // a drone or a locked chord is turned off without hunting for a control.
      if (sustained.has(degreeIndex)) {
        stopSustained(degreeIndex);
        syncHeld();
        return;
      }
      // In sequencer mode a key press writes a step rather than playing a
      // chord, with a short preview so it can be heard as it is entered.
      if (isSequencer(s.mode)) {
        if (sequencer.add({ degreeIndex, mods: [...modifiers.active()] }, currentStep() + 1)) {
          engine.strike(notesFor(degreeIndex), soundOpts(s),
            engine.context() ? engine.context().currentTime : 0, 0.25);
          state.set({ sequence: sequencer.steps().map(step => step.degreeIndex) });
        }
        return;
      }
      // A drum is a hit, not a held note: it sounds once and rings out, so
      // nothing is tracked as held and there is nothing to release.
      if (isDrums(s.mode)) {
        const drum = DRUM_MAP[degreeIndex % DRUM_MAP.length];
        engine.strikeDrum(drum, s.kit);
        // With auto-drum on, holding the key keeps it hitting, so the key has to
        // be tracked. It carries a drum rather than a voice set: there is
        // nothing to release, retune or rebuild.
        if (s.autoDrum !== 'off') {
          const entry = { degreeIndex, drum, set: null, step: 0, holders: new Set() };
          heldPointers.set(degreeIndex, entry);
          addHolder(entry, pointerId);
          syncHeld();
        }
        return;
      }
      // Lead is monophonic and drone replaces what is ringing, so both clear
      // whatever came before rather than layering on top of it. Unless the hold
      // lock is on: it means keep sounding, and it outranks the mode. Nothing
      // the lock is holding is let go of except by unlocking it or by pressing
      // the key again.
      // With glide on, a monophonic line slides from the note it is on to the
      // new one. Only when the voice count matches: there is nothing to slide
      // between otherwise.
      const glide = glideSeconds(s);
      if (glide && s.mode === 'lead' && heldPointers.size === 1) {
        const entry = [...heldPointers.values()][0];
        const notes = notesForPress(s.mode, notesFor(degreeIndex, { remember: true }));
        if (engine.retuneChord(entry.set, notes, glide)) {
          forget(entry);
          entry.degreeIndex = degreeIndex;
          entry.holders = new Set();
          heldPointers.set(degreeIndex, entry);
          addHolder(entry, pointerId);
          syncHeld();
          return;
        }
      }
      if (!s.hold && (s.mode === 'lead' || s.mode === 'drone')) releaseEverything();
      const entry = { degreeIndex, set: voicesFor(degreeIndex), step: 0, holders: new Set() };
      heldPointers.set(degreeIndex, entry);
      addHolder(entry, pointerId);
      syncHeld();
      // Anything that wants to know what was played, rather than what was heard:
      // the ear trainer marking an answer, for one.
      if (onChord) onChord({ degreeIndex, mods: [...modifiers.active()] });
    },
    // The degree is ignored on purpose: a finger releases whatever it started,
    // wherever it happens to be when it lifts.
    chordUp(_degreeIndex, pointerId) {
      const entry = entryFor(pointerId);
      if (!entry) return;
      // Something else is still pressing this key, so the note goes on: that is
      // what makes moving from the keyboard to the mouse mid note possible.
      if (!dropHolder(entry, pointerId)) return;

      // An auto-drum key rings out on its own: lifting the finger only stops
      // the repeats.
      if (entry.drum) {
        heldPointers.delete(entry.degreeIndex);
        syncHeld();
        return;
      }
      // Drone keeps sounding after the finger lifts, which is the whole point of
      // it, and the hold lock does the same in every other mode.
      const s = state.get();
      heldPointers.delete(entry.degreeIndex);
      if (s.mode === 'drone' || s.hold) {
        // A drone replaces the last one, but not while the lock is on.
        if (s.mode === 'drone' && !s.hold) stopAllSustained();
        sustained.set(entry.degreeIndex, entry.set);
        syncHeld();
        return;
      }
      engine.stopChord(entry.set, releaseFor(entry.set));
      syncHeld();
    },
    modPress(id, { now = performance.now() } = {}) {
      applyModifierChange(() => modifiers.press(id, now));
    },
    modRelease(id, { now = performance.now() } = {}) {
      applyModifierChange(() => modifiers.release(id, now));
    },
    // Dragging a finger across the pad should play what is under it, the way a
    // finger dragged across real keys does.
    chordSlide(degreeIndex, pointerId) {
      const entry = entryFor(pointerId);
      if (!entry || entry.degreeIndex === degreeIndex) return;
      // What is already sounding on the key being slid onto, if anything. One
      // key is one chord, so the finger joins it rather than starting a second:
      // putting this entry there instead left the chord that was there with
      // nothing pointing at it, and a chord nothing points at is never released.
      // Two fingers swiping across the pad is all it takes to cross like that.
      const already = heldPointers.get(degreeIndex);
      // Only the finger that moved: anything else holding the old key keeps it.
      if (!dropHolder(entry, pointerId)) {
        this.chordDown(degreeIndex, pointerId);
        return;
      }
      heldPointers.delete(entry.degreeIndex);
      if (already) {
        if (!entry.drum) engine.stopChord(entry.set, releaseFor(entry.set));
        addHolder(already, pointerId);
        syncHeld();
        return;
      }

      const glide = glideSeconds(state.get());
      const sliding = notesForPress(state.get().mode, notesFor(degreeIndex, { remember: true }));
      if (glide && engine.retuneChord(entry.set, sliding, glide)) {
        entry.degreeIndex = degreeIndex;
        heldPointers.set(degreeIndex, entry);
        addHolder(entry, pointerId);
        syncHeld();
        return;
      }
      engine.stopChord(entry.set, releaseFor(entry.set));
      entry.degreeIndex = degreeIndex;
      entry.set = voicesFor(degreeIndex);
      heldPointers.set(degreeIndex, entry);
      addHolder(entry, pointerId);
      syncHeld();
    },
    // What the sequencer is playing, written out as looper events. Leaving the
    // mode should not throw the pattern away, and a bounced track can then be
    // played over, muted or turned live like any other.
    bounceSequence() {
      const s = state.get();
      const steps = sequencer.steps();
      if (steps.length === 0) return null;
      const events = steps.map((step, index) => ({
        at: index * STEPS_PER_CHORD,
        steps: STEPS_PER_CHORD * 0.9,
        payload: {
          notes: voicing(s.keyRoot, step.degreeIndex, new Set(step.mods), s.baseOctave, s.scale,
            { inversion: s.inversion, bass: s.bass }),
          opts: soundOpts(s),
        },
      }));
      return { events, steps: steps.length * STEPS_PER_CHORD };
    },

    // The same for the drum pattern: one bar of whatever beat is running.
    bounceBeat() {
      const s = state.get();
      if (!s.beat || s.beat === 'off') return null;
      const events = [];
      for (let step = 0; step < STEPS_PER_PATTERN; step++) {
        for (const hit of hitsAt(s.beat, step, s.beatVariation)) {
          events.push({ at: step, steps: 1, payload: { drum: hit.drum, kit: s.kit, gain: hit.gain } });
        }
      }
      return events.length ? { events, steps: STEPS_PER_PATTERN } : null;
    },

    // Sounds a chord that nobody pressed, for the ear trainer to ask with.
    playChordFor({ degreeIndex, mods }, seconds = 1.4) {
      const s = state.get();
      const notes = voicing(s.keyRoot, degreeIndex, new Set(mods), s.baseOctave, s.scale, {
        inversion: s.inversion,
        bass: s.bass,
      });
      const context = engine.context();
      engine.strike(notes, soundOpts(s), context ? context.currentTime : 0, seconds);
    },
    releaseFor,
    releaseHeld,
    // Whether this finger, mouse or key is holding anything, which is the only
    // case where working out what is under it is worth a hit test.
    holdsPointer(pointerId) { return holderOf.has(pointerId); },
    // Chords, not fingers: two things pressing one key is one chord.
    heldCount() { return heldPointers.size; },
    holdersOf(degreeIndex) {
      const entry = heldPointers.get(degreeIndex);
      return entry ? holdersFor(entry).size : 0;
    },
    sequencer,
    sustainedCount() { return sustained.size; },
    releaseSustained: stopAllSustained,
    currentStep,
    rebuildAllHeld,
    applyTone,
    playRecorded,
    releaseEverything,
  };
}
