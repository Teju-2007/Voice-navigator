function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SYNONYMS = {
  add: ['new', 'create', 'upload', 'plus'],
  create: ['new', 'add', 'make', 'start'],
  edit: ['change', 'modify', 'update', 'pencil'],
  file: ['document', 'page'],
  repository: ['repo', 'project', 'codebase'],
  save: ['commit', 'submit', 'publish', 'done'],
  sign: ['register', 'join'],
  account: ['profile', 'user'],
  readme: ['read me', 'readme md'],
  upload: ['import', 'attach'],
  continue: ['next', 'proceed'],
  delete: ['remove', 'trash']
};

function expandWords(words) {
  const expanded = new Set(words);
  for (const word of words) {
    for (const [key, values] of Object.entries(SYNONYMS)) {
      if (word === key || values.includes(word)) {
        expanded.add(key);
        values.forEach((value) => expanded.add(value));
      }
    }
  }
  return expanded;
}

function tokenize(str) {
  return normalize(str).split(/\s+/).filter(Boolean);
}

function wordOverlapScore(transcript, elementText) {
  const t = normalize(transcript);
  const e = normalize(elementText);
  if (!t || !e) return 0;

  const tWords = tokenize(t);
  const eWords = tokenize(e);
  const expandedTranscript = expandWords(tWords);

  let overlap = 0;
  for (const ew of eWords) {
    if (expandedTranscript.has(ew)) {
      overlap += 1;
    } else {
      for (const tw of tWords) {
        if (tw.length > 2 && (ew.includes(tw) || tw.includes(ew))) {
          overlap += 0.5;
          break;
        }
      }
    }
  }

  const exactIntent = tWords.some((word) =>
    eWords.some((elementWord) => word.length > 3 && elementWord.startsWith(word))
  );
  // Give multi-word labels a small advantage when several controls share one
  // generic word such as "new", "open", or "save".
  const score = overlap / Math.max(1, Math.min(eWords.length, 4)) +
    Math.min(overlap, 2) * 0.06;
  return exactIntent ? score + 0.1 : score;
}

const MATCH_THRESHOLD = 0.32;

function findBestMatch(transcript, elements, options = {}) {
  let best = null;
  let bestScore = 0;

  for (const el of elements) {
    if (el.disabled) continue;
    const searchableText = [el.text, el.ariaLabel, el.placeholder, el.name]
      .filter(Boolean)
      .join(' ');
    let score = wordOverlapScore(transcript, searchableText);

    if (options.preferActions && el.tagName) {
      const tag = el.tagName.toLowerCase();
      if (['button', 'a'].includes(tag) || el.role === 'button') score += 0.05;
    }

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return bestScore >= (options.threshold || MATCH_THRESHOLD)
    ? { element: best, score: bestScore }
    : null;
}

window.VoiceNavigatorMatch = {
  normalize,
  tokenize,
  wordOverlapScore,
  findBestMatch,
  MATCH_THRESHOLD
};
