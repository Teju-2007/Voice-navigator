const HIGHLIGHT_ID = 'voice-navigator-highlight';
const PANEL_ID = 'voice-navigator-panel';
const INTERACTIVE_SELECTOR =
  'button, a, [role="button"], input:not([type="hidden"]), textarea, select, [role="link"], [role="menuitem"], [contenteditable="true"]';

let elementCache = [];
let currentHighlight = null;
let task = null;
let planTimer = null;
let plannerBusy = false;
let remotePlannerDisabled = false;
let remotePlanKey = '';
let remotePlanCache = null;
let pendingAnswerTimer = null;
let lastUrl = location.href;

function normalize(value) {
  return window.VoiceNavigatorMatch.normalize(value);
}

function labelOf(item) {
  return (item?.text || item?.ariaLabel || item?.placeholder || item?.name || '').trim();
}

function scanInteractiveElements() {
  elementCache = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return (rect.width > 0 && rect.height > 0) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName);
    })
    .map((node, index) => ({
      node,
      index,
      tagName: node.tagName,
      role: node.getAttribute('role') || '',
      type: node.getAttribute('type') || '',
      contentEditable: node.isContentEditable,
      href: node.getAttribute('href') || '',
      ariaLabel: node.getAttribute('aria-label') || '',
      placeholder: node.getAttribute('placeholder') || '',
      name: node.getAttribute('name') || '',
      disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true',
      text: (
        node.innerText ||
        node.getAttribute('aria-label') ||
        node.getAttribute('title') ||
        (node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.innerText : '') ||
        node.closest('label')?.innerText ||
        node.getAttribute('placeholder') ||
        node.getAttribute('name') ||
        node.value ||
        ''
      ).trim()
    }))
    .filter((item) => item.text || ['INPUT', 'TEXTAREA', 'SELECT'].includes(item.node.tagName));
}

function removeHighlight() {
  document.getElementById(HIGHLIGHT_ID)?.remove();
  currentHighlight = null;
}

function highlightElement(node, proactive = false) {
  removeHighlight();
  if (!node || !node.isConnected) return;
  const rect = node.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const box = document.createElement('div');
  box.id = HIGHLIGHT_ID;
  box.className = proactive ? 'vn-proactive' : 'vn-matched';
  box.style.left = `${rect.left - 4}px`;
  box.style.top = `${rect.top - 4}px`;
  box.style.width = `${rect.width + 8}px`;
  box.style.height = `${rect.height + 8}px`;
  document.body.appendChild(box);
  currentHighlight = box;
}

function renderPanel(message, state = 'guiding') {
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
  }
  panel.className = `vn-${state}`;
  panel.textContent = message || '';
}

function saveTask() {
  if (!task) return;
  chrome.runtime.sendMessage({
    type: 'TASK_UPDATE',
    task: {
      goal: task.goal,
      phase: task.phase,
      step: task.step,
      answers: task.answers,
      history: task.history.slice(-30),
      pendingField: task.pendingField,
      pendingQuestion: task.pendingQuestion
    }
  }).catch(() => {});
}

function pageSnapshot() {
  return {
    url: location.href,
    title: document.title,
    headings: Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .map((node) => node.innerText?.trim())
      .filter(Boolean)
      .slice(0, 20),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3500),
    elements: elementCache.slice(0, 120).map((item) => ({
      tagName: item.tagName,
      role: item.role,
      type: item.type,
      text: item.text,
      href: item.href,
      ariaLabel: item.ariaLabel,
      placeholder: item.placeholder,
      name: item.name,
      disabled: item.disabled,
      value: item.type === 'password' ? '' : (item.node.value || ''),
      checked: Boolean(item.node.checked)
    }))
  };
}

async function requestRemotePlan() {
  if (remotePlannerDisabled || !task) return null;
  const key = `${location.href}|${task.goal}|${task.step}|${task.history.length}|${task.pendingField || ''}`;
  if (key === remotePlanKey) return remotePlanCache;
  remotePlanKey = key;
  try {
    const response = await fetch('http://localhost:3000/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: task.goal,
        answers: task.answers,
        page: pageSnapshot(),
        history: task.history.slice(-12)
      })
    });
    if (response.status === 503 || !response.ok) {
      remotePlannerDisabled = true;
      return null;
    }
    remotePlanCache = await response.json();
    return remotePlanCache;
  } catch {
    remotePlannerDisabled = true;
    task.plannerUnavailable = true;
    return null;
  }
}

function applyRemotePlan(plan) {
  if (!plan || !['continue', 'ask', 'complete'].includes(plan.status)) return false;
  if (plan.status === 'complete') {
    task.phase = 'complete';
    task.expected = null;
    renderPanel(plan.message || 'The page indicates that this task is complete.', 'complete');
    saveTask();
    return true;
  }
  if (plan.status === 'ask') {
    ask(plan.message || 'What information should I use for the next step?', plan.field || 'remoteAnswer');
    return true;
  }
  const requestedLabel = plan.action?.label;
  const item = requestedLabel ? findElement([requestedLabel]) : null;
  if (!item) return false;
  guide(
    plan.action.type || 'click',
    item,
    plan.message || `Next: ${labelOf(item)}`,
    plan.action.value || null
  );
  return true;
}

function findElement(terms, options = {}) {
  let best = null;
  let bestScore = 0;
  for (const item of elementCache) {
    if (item.disabled) continue;
    const searchable = normalize(
      [item.text, item.ariaLabel, item.placeholder, item.name].filter(Boolean).join(' ')
    );
    let score = 0;
    for (const term of terms) {
      const wanted = normalize(term);
      if (searchable === wanted) score += 5;
      else if (searchable.includes(wanted)) score += 2;
    }
    if (options.button && ['BUTTON', 'A'].includes(item.tagName)) score += 1;
    if (options.input && ['INPUT', 'TEXTAREA', 'SELECT'].includes(item.tagName)) score += 1;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function containsAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function hasAnswer(name) {
  return Boolean(task?.answers?.[name]?.trim());
}

function recentlyHandled(label) {
  const wanted = normalize(label);
  return task.history.some((entry) =>
    entry.url === location.href &&
    normalize(entry.label) === wanted &&
    Date.now() - entry.at < 3000
  );
}

function ask(question, field) {
  task.phase = 'waiting-for-input';
  task.pendingField = field;
  task.pendingQuestion = question;
  task.expected = null;
  renderPanel(question, 'waiting');
  saveTask();
  return { status: 'ask', message: question };
}

function guide(type, item, message, value = null) {
  if (!item) return null;
  task.phase = 'guiding';
  task.step += 1;
  task.expected = { type, index: item.index, value };
  task.history.push({
    type,
    label: labelOf(item),
    url: location.href,
    at: Date.now()
  });
  task.history = task.history.slice(-30);
  highlightElement(item.node);
  renderPanel(message || `Next: ${labelOf(item)}`, 'guiding');
  saveTask();
  return { status: 'continue', action: task.expected, message };
}

function localPlan() {
  const goal = normalize(task.goal);
  const isGithub = /github/i.test(location.hostname);
  const repoGoal =
    (goal.includes('repository') || goal.includes('repo')) &&
    containsAny(goal, ['create', 'new', 'make', 'start']);
  const newFileGoal = containsAny(goal, ['create new file', 'new file', 'add file', 'create file']);
  const readmeGoal = goal.includes('readme');
  const uploadGoal = containsAny(goal, ['upload file', 'upload files', 'new files', 'add files']);
  const accountGoal = containsAny(goal, ['create account', 'sign up', 'signup', 'register']);

  if (isGithub && repoGoal) {
    const name = findElement(['repository name', 'repo name', 'name'], { input: true });
    const create = findElement(['create repository', 'create repo'], { button: true });
    const newRepo = findElement(['new repository', 'new repo', 'new'], { button: true });
    if (name && !hasAnswer('repositoryName')) return ask('What should the repository be named?', 'repositoryName');
    if (name && hasAnswer('repositoryName') && !recentlyHandled(labelOf(name))) {
      return guide('type', name, `I’ll enter “${task.answers.repositoryName}” in the repository name field.`, task.answers.repositoryName);
    }
    if (create && !recentlyHandled(labelOf(create))) {
      return guide('click', create, 'The form is ready. Click Create repository to finish.');
    }
    if (newRepo && !recentlyHandled(labelOf(newRepo))) {
      return guide('click', newRepo, 'Open the new repository form.');
    }
  }

  if (isGithub && newFileGoal) {
    const addFile = findElement(['add file'], { button: true });
    const createFile = findElement(['create new file'], { button: true });
    const fileName = findElement(['file name', 'name your file', 'name'], { input: true });
    const editor = elementCache.find((item) => item.tagName === 'TEXTAREA' || item.contentEditable) ||
      findElement(['edit file', 'content', 'text area'], { input: true });
    const commit = findElement(['commit changes', 'commit'], { button: true });
    if (addFile && !createFile && !recentlyHandled(labelOf(addFile))) {
      return guide('click', addFile, 'Open the Add file menu.');
    }
    if (createFile && !recentlyHandled(labelOf(createFile))) {
      return guide('click', createFile, 'Choose Create new file.');
    }
    if (fileName && !hasAnswer('fileName')) return ask('What should the new file be called?', 'fileName');
    if (fileName && hasAnswer('fileName') && !recentlyHandled(labelOf(fileName))) {
      return guide('type', fileName, `I’ll enter “${task.answers.fileName}” as the file name.`, task.answers.fileName);
    }
    if (editor && !hasAnswer('fileContents')) {
      return ask('What content should I put in the new file?', 'fileContents');
    }
    if (editor && hasAnswer('fileContents') && !recentlyHandled(labelOf(editor))) {
      return guide('type', editor, 'I’ll put that content in the editor.', task.answers.fileContents);
    }
    if (commit && !recentlyHandled(labelOf(commit))) {
      return guide('click', commit, 'Save the new file by committing the changes.');
    }
  }

  if (isGithub && readmeGoal) {
    const readme = findElement(['readme', 'readme md']);
    const edit = findElement(['edit this file', 'edit', 'pencil'], { button: true });
    const editor = elementCache.find((item) => item.tagName === 'TEXTAREA' || item.contentEditable) ||
      findElement(['edit file', 'content'], { input: true });
    const commit = findElement(['commit changes', 'commit'], { button: true });
    if (readme && !location.pathname.includes('/blob/') && !recentlyHandled(labelOf(readme))) {
      return guide('click', readme, 'Open the README file.');
    }
    if (edit && !recentlyHandled(labelOf(edit))) return guide('click', edit, 'Open the README editor.');
    if (editor && !hasAnswer('readmeContents')) return ask('What should the README say?', 'readmeContents');
    if (editor && hasAnswer('readmeContents') && !recentlyHandled(labelOf(editor))) {
      return guide('type', editor, 'I’ll enter the new README content.', task.answers.readmeContents);
    }
    if (commit && !recentlyHandled(labelOf(commit))) {
      return guide('click', commit, 'Commit the README changes to save them.');
    }
  }

  if (isGithub && uploadGoal) {
    const addFile = findElement(['add file'], { button: true });
    const upload = findElement(['upload files', 'upload file'], { button: true });
    const fileInput = elementCache.find((item) => item.type === 'file');
    const commit = findElement(['commit changes', 'commit'], { button: true });
    if (addFile && !upload && !recentlyHandled(labelOf(addFile))) {
      return guide('click', addFile, 'Open the Add file menu.');
    }
    if (upload && !recentlyHandled(labelOf(upload))) return guide('click', upload, 'Choose Upload files.');
    if (fileInput && !fileInput.node.files?.length) {
      return ask('Choose the files in the file picker. When they appear, say continue.', 'filesChosen');
    }
    if (commit && !recentlyHandled(labelOf(commit))) {
      return guide('click', commit, 'Commit the uploaded files to save them.');
    }
  }

  if (accountGoal) {
    const signup = findElement(['sign up', 'create account', 'register', 'join'], { button: true });
    const password = elementCache.find((item) => item.type === 'password');
    const next = findElement(['create account', 'sign up', 'continue', 'next', 'register'], { button: true });
    if (signup && !recentlyHandled(labelOf(signup))) return guide('click', signup, 'Open the account creation form.');
    if (password && !hasAnswer('passwordDone')) {
      return ask('Enter your password directly. I will not listen to or store it. Then say continue.', 'passwordDone');
    }
    if (next && !recentlyHandled(labelOf(next))) return guide('click', next, 'Continue the account creation form.');
  }

  const direct = window.VoiceNavigatorMatch.findBestMatch(task.goal, elementCache, {
    preferActions: true,
    threshold: 0.25
  });
  if (direct && !recentlyHandled(labelOf(direct.element))) {
    return guide('click', direct.element, `The next relevant control is “${labelOf(direct.element)}”.`);
  }

  const pageText = normalize(`${document.title} ${document.body?.innerText || ''}`);
  if (containsAny(pageText, ['successfully created', 'repository created', 'changes committed', 'welcome'])) {
    task.phase = 'complete';
    task.expected = null;
    renderPanel('The page indicates that this task is complete.', 'complete');
    saveTask();
    return { status: 'complete', message: 'The page indicates that this task is complete.' };
  }

  const fallbackMessage = task.plannerUnavailable
    ? 'I heard you, but the local planner is unavailable. Start Ollama, then restart the backend and reload the extension.'
    : 'I cannot see the next control yet. Scroll or open the relevant menu, then say “continue”.';
  return ask(fallbackMessage, 'continue');
}

function runPlan(delay = 150) {
  clearTimeout(planTimer);
  planTimer = setTimeout(async () => {
    if (!task || plannerBusy) return;
    plannerBusy = true;
    scanInteractiveElements();
    try {
      if (task.expected) {
        const expected = elementCache.find((entry) => entry.index === task.expected.index);
        if (expected) {
          highlightElement(expected.node);
          return;
        }
        task.expected = null;
      }
      let result = null;
      // Use one planner path for every domain. The local rules remain a
      // deterministic fallback when the semantic planner is unavailable.
      const remote = await requestRemotePlan();
      if (remote && applyRemotePlan(remote)) return;
      result = localPlan();
      if (result?.action) {
        const item = elementCache.find((entry) => entry.index === result.action.index);
        if (item) highlightElement(item.node);
      }
    } finally {
      plannerBusy = false;
    }
  }, delay);
}

function setNativeValue(node, value) {
  if (node.isContentEditable) {
    node.textContent = value;
  } else {
    const prototype = node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(node, value);
    else node.value = value;
  }
  node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function executeExpected() {
  if (!task?.expected) return false;
  const item = elementCache.find((entry) => entry.index === task.expected.index);
  if (!item || !item.node.isConnected) return false;
  if (task.expected.type === 'type' && item.type !== 'password' && item.type !== 'file') {
    setNativeValue(item.node, task.expected.value || '');
    item.node.focus();
  } else if (task.expected.type === 'select' && item.node.tagName === 'SELECT') {
    const wanted = normalize(task.expected.value || '');
    const option = Array.from(item.node.options).find((candidate) =>
      normalize(`${candidate.text} ${candidate.value}`) === wanted ||
      normalize(`${candidate.text} ${candidate.value}`).includes(wanted)
    );
    if (option) {
      item.node.value = option.value;
      item.node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      item.node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
  } else if (task.expected.type === 'check') {
    if (item.type === 'checkbox' || item.type === 'radio') {
      if (!item.node.checked) item.node.click();
    } else {
      item.node.focus();
    }
  } else if (task.expected.type === 'scroll') {
    item.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (task.expected.type === 'click') {
    item.node.click();
  } else {
    item.node.focus();
  }
  task.expected = null;
  saveTask();
  runPlan(500);
  return true;
}

function handleTranscript(transcript, endOfTurn) {
  if (!transcript) return;
  const lower = normalize(transcript);
  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  // Do not require AssemblyAI's final-turn flag to begin. Some microphones
  // and network paths deliver partial Turns without a reliable end_of_turn.
  // Start after three words, then keep extending the goal until an action is
  // chosen.
  if (!task && (endOfTurn || wordCount >= 3)) {
    task = {
      goal: transcript.trim(),
      phase: 'guiding',
      step: 0,
      answers: {},
      history: [],
      expected: null,
      pendingField: null,
      pendingQuestion: null,
      plannerUnavailable: false
    };
    renderPanel(`Heard: ${task.goal}. Planning the first step…`);
    saveTask();
    runPlan(endOfTurn ? 0 : 350);
    return;
  }
  if (!task) {
    renderPanel(`Heard: ${transcript.trim()}…`, 'guiding');
    return;
  }

  if (
    !task.expected &&
    !task.pendingField &&
    task.step === 0 &&
    task.history.length === 0 &&
    transcript.trim().length > task.goal.length
  ) {
    task.goal = transcript.trim();
    renderPanel(`Heard: ${task.goal}. Planning the first step…`, 'guiding');
    saveTask();
    runPlan(350);
  }

  if (containsAny(lower, ['stop navigating', 'cancel task', 'cancel navigation'])) {
    task = null;
    removeHighlight();
    document.getElementById(PANEL_ID)?.remove();
    chrome.runtime.sendMessage({ type: 'TASK_CLEARED' }).catch(() => {});
    return;
  }

  if (task.pendingField) {
    clearTimeout(pendingAnswerTimer);
    const pendingTranscript = transcript.trim();
    const acceptPendingAnswer = () => {
      if (!task?.pendingField) return;
      const field = task.pendingField;
      if (!['continue', 'filesChosen', 'passwordDone'].includes(field)) {
        task.answers[field] = pendingTranscript;
      }
      if (field === 'passwordDone') task.answers.passwordDone = 'true';
      task.pendingField = null;
      task.pendingQuestion = null;
      task.phase = 'guiding';
      saveTask();
      runPlan(0);
    };
    if (endOfTurn) acceptPendingAnswer();
    else pendingAnswerTimer = setTimeout(acceptPendingAnswer, 900);
    return;
  }

  if (task.expected && endOfTurn && containsAny(lower, ['click it', 'press it', 'open it', 'go ahead', 'continue', 'do it'])) {
    executeExpected();
    return;
  }

  if (endOfTurn && containsAny(lower, ['start over', 'instead'])) {
    task.goal = transcript.trim();
    task.history = [];
    task.answers = {};
    task.step = 0;
    runPlan(0);
  }
}

function resumeTask(saved) {
  if (!saved) return;
  task = {
    goal: saved.goal,
    phase: saved.phase || 'guiding',
    step: saved.step || 0,
    answers: saved.answers || {},
    history: saved.history || [],
    expected: null,
    pendingField: saved.pendingField || null,
    pendingQuestion: saved.pendingQuestion || null
  };
  renderPanel(task.pendingQuestion || 'Resuming your task…', task.phase);
  runPlan(100);
}

function pageChanged() {
  if (!task) return;
  task.expected = null;
  task.phase = 'guiding';
  renderPanel('The page changed. Finding the next step…');
  saveTask();
  runPlan(300);
}

scanInteractiveElements();
new MutationObserver(() => {
  scanInteractiveElements();
  if (task && !plannerBusy) runPlan(350);
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true });

setInterval(() => {
  scanInteractiveElements();
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    pageChanged();
  }
  if (task?.expected) {
    const item = elementCache.find((entry) => entry.index === task.expected.index);
    if (item) highlightElement(item.node);
  }
}, 1000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONTENT_PING') {
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'TURN_UPDATE') handleTranscript(message.transcript, message.endOfTurn);
  if (message.type === 'TASK_RESUME') resumeTask(message.task);
  if (message.type === 'STOP_TASK') {
    task = null;
    removeHighlight();
    document.getElementById(PANEL_ID)?.remove();
  }
  if (message.type === 'CAPTURE_ERROR') console.warn('[Voice Navigator]', message.message);
});

window.addEventListener('scroll', () => {
  if (task?.expected) {
    const item = elementCache.find((entry) => entry.index === task.expected.index);
    if (item) highlightElement(item.node);
  }
});

document.addEventListener('click', (event) => {
  if (!task || !event.isTrusted) return;
  const clicked = elementCache.find((item) => item.node === event.target || item.node.contains(event.target));
  if (!clicked) return;
  if (task.expected && task.expected.index === clicked.index && task.expected.type !== 'click') {
    executeExpected();
    return;
  }
  task.expected = null;
  task.history.push({ type: 'user-click', label: labelOf(clicked), url: location.href, at: Date.now() });
  task.history = task.history.slice(-30);
  saveTask();
  runPlan(500);
}, true);

document.addEventListener('input', (event) => {
  if (!task || !event.isTrusted) return;
  const changed = elementCache.find((item) => item.node === event.target);
  if (changed) {
    if (changed.type === 'password') task.answers.passwordDone = 'true';
    task.expected = null;
    saveTask();
    runPlan(500);
  }
}, true);

chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});