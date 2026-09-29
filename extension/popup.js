const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');
const setupLink = document.getElementById('setupLink');

function showListening(message = 'Listening — say what you want to do on this page.') {
  startBtn.style.display = 'none';
  stopBtn.style.display = 'block';
  status.textContent = message;
  status.className = 'active';
}

function showStopped(message = 'Not listening.') {
  stopBtn.style.display = 'none';
  startBtn.style.display = 'block';
  status.textContent = message;
  status.className = message === 'Not listening.' ? '' : 'error';
}

function showState(state) {
  if (!state) return;
  if (state.status === 'error') {
    showStopped(`Error: ${state.message}`);
  } else if (['starting', 'requesting-microphone', 'microphone-ready', 'connecting', 'listening'].includes(state.status)) {
    showListening(state.message);
  } else {
    showStopped(state.message);
  }
}

// Reflect the REAL current state on open, instead of always assuming
// "Start Listening" — the popup is a brand-new instance every time you
// open it, so without this it can't tell you what's actually happening
// in the background.
chrome.storage.local.get(['isListening', 'captureState'], (result) => {
  if (result.captureState) showState(result.captureState);
  else if (result.isListening) showListening();
  else showStopped();
});

startBtn.addEventListener('click', async () => {
  showListening('Starting microphone…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'START_LISTENING' });
    if (!response?.ok) showStopped(response?.error || 'Could not start listening.');
  } catch (err) {
    showStopped(`Could not start listening: ${err.message}`);
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_LISTENING' });
  } finally {
    showStopped();
  }
});

setupLink.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.captureState?.newValue) {
    showState(changes.captureState.newValue);
  }
});
