// The ear trainer. It asks for a chord, listens to what is pressed, and keeps
// score. Everything here is pure: what to ask, and whether an answer is right.
// Playing the question and drawing the score belong to whoever calls it.

// Four levels, as the device has. Each one adds something to hear rather than
// simply adding more chords: first the shape of the key, then every degree,
// then the sevenths, then the chords that need a second listen.
export const LEVELS = [
  { id: 1, label: '1 · I IV V', degrees: [0, 3, 4], mods: [[]] },
  { id: 2, label: '2 · all seven', degrees: [0, 1, 2, 3, 4, 5, 6], mods: [[]] },
  {
    id: 3,
    label: '3 · sevenths',
    degrees: [0, 1, 2, 3, 4, 5, 6],
    mods: [[], ['dom7'], ['maj7'], ['six']],
  },
  {
    id: 4,
    label: '4 · extended',
    degrees: [0, 1, 2, 3, 4, 5, 6],
    mods: [[], ['dom7'], ['maj7'], ['six'], ['sus4'], ['add9'], ['dom7', 'add9'], ['dim']],
  },
];

export const LEVEL_IDS = LEVELS.map(level => level.id);

export function levelFor(id) {
  return LEVELS.find(level => level.id === id) || LEVELS[0];
}

// A question is a degree and the modifiers to sound it with. The random source
// is handed in so a test can ask for a known question.
export function pickQuestion(levelId, random = Math.random) {
  const level = levelFor(levelId);
  const degreeIndex = level.degrees[Math.floor(random() * level.degrees.length) % level.degrees.length];
  const mods = level.mods[Math.floor(random() * level.mods.length) % level.mods.length];
  return { degreeIndex, mods: [...mods] };
}

// The answer is the chord that was pressed, so it is right when it is the same
// chord: the same degree, sounded the same way. Order of modifiers never counts.
export function isCorrect(question, answer) {
  if (!question || !answer || question.degreeIndex !== answer.degreeIndex) return false;
  const asked = [...question.mods].sort();
  const given = [...answer.mods].sort();
  return asked.length === given.length && asked.every((mod, i) => mod === given[i]);
}

export function createTrainer({ random = Math.random } = {}) {
  let level = 1;
  let question = null;
  let asked = 0;
  let right = 0;
  let last = null;

  function state() {
    return { level, question, asked, right, last, running: question !== null };
  }

  return {
    state,
    setLevel(next) {
      level = levelFor(next).id;
      return state();
    },
    start() {
      asked = 0;
      right = 0;
      last = null;
      question = pickQuestion(level, random);
      return state();
    },
    stop() {
      question = null;
      last = null;
      return state();
    },
    // An answer always moves on to the next question: dwelling on a wrong one
    // teaches the wrong chord.
    answer(given) {
      if (!question) return state();
      const correct = isCorrect(question, given);
      asked += 1;
      if (correct) right += 1;
      last = correct ? 'right' : 'wrong';
      question = pickQuestion(level, random);
      return state();
    },
  };
}
