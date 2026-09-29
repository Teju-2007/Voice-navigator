let listeningTabId = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture microphone audio and stream it to AssemblyAI for live transcription.'
  });
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function sendToTab(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The content script is not available on browser-owned pages.
  }
}

async function ensureContentScript(tabId) {
  if (!tabId) return;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PING' });
    if (response?.ok) return;
  } catch {
    // The tab was open before the extension loaded, or the page has no script.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['match.js', 'content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['styles.css']
    });
  } catch {
    // chrome:// and store pages reject script injection. Listening can still
    // start, and the popup will make the capture status visible.
  }
}

async function setCaptureState(state) {
  await chrome.storage.local.set({
    captureState: { ...state, updatedAt: Date.now() },
    isListening: !['error', 'stopped'].includes(state.status)
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const keepResponseOpen = ['START_LISTENING', 'STOP_LISTENING'].includes(message.type);
  (async () => {
    if (message.type === 'START_LISTENING') {
      try {
        const tab = await activeTab();
        listeningTabId = tab?.id || null;
        await ensureContentScript(listeningTabId);
        await setCaptureState({ status: 'starting', message: 'Starting microphone…' });
        await ensureOffscreenDocument();
        // Small delay so the offscreen document has finished registering its listener.
        setTimeout(() => chrome.runtime.sendMessage({ type: 'BEGIN_CAPTURE' }), 150);
        sendResponse({ ok: true });
      } catch (err) {
        const messageText = `Could not start the microphone capture (${err.message || 'unknown error'}).`;
        await setCaptureState({ status: 'error', message: messageText });
        sendResponse({ ok: false, error: messageText });
      }
      return;
    }

    if (message.type === 'STOP_LISTENING') {
      try {
        chrome.runtime.sendMessage({ type: 'END_CAPTURE' });
        setTimeout(() => closeOffscreenDocument(), 300);
        await setCaptureState({ status: 'stopped', message: 'Not listening.' });
        const tabId = listeningTabId || (await activeTab())?.id;
        if (tabId) {
          await chrome.storage.local.remove(`task:${tabId}`);
          await sendToTab(tabId, { type: 'STOP_TASK' });
        }
        listeningTabId = null;
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    if (message.type === 'CAPTURE_STATUS') {
      await setCaptureState({ status: message.status, message: message.message });
      return;
    }

    if (message.type === 'TURN_UPDATE' || message.type === 'CAPTURE_ERROR') {
      if (message.type === 'CAPTURE_ERROR') {
        // Mic capture actually failed — make sure the popup doesn't keep
        // claiming "Listening" when nothing is really happening.
        await setCaptureState({ status: 'error', message: message.message });
        await closeOffscreenDocument();
      }

        const tabId = listeningTabId || (await activeTab())?.id;
        if (tabId) await sendToTab(tabId, message);
      return;
    }

    if (message.type === 'CONTENT_READY') {
      const tabId = sender.tab?.id;
      if (!tabId) return;
      const result = await chrome.storage.local.get(`task:${tabId}`);
      if (result[`task:${tabId}`]) {
        await sendToTab(tabId, { type: 'TASK_RESUME', task: result[`task:${tabId}`] });
      }
      return;
    }

    if (message.type === 'TASK_UPDATE') {
      const tabId = sender.tab?.id || (await activeTab())?.id;
      if (tabId && message.task) {
        await chrome.storage.local.set({ [`task:${tabId}`]: message.task });
      }
      return;
    }

    if (message.type === 'TASK_CLEARED') {
      const tabId = sender.tab?.id || (await activeTab())?.id;
      if (tabId) await chrome.storage.local.remove(`task:${tabId}`);
      return;
    }
  })();

  // Only START/STOP use sendResponse. Returning true for task updates would
  // leave content-script message channels open until Chrome times them out.
  return keepResponseOpen;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const result = await chrome.storage.local.get(`task:${tabId}`);
  const savedTask = result[`task:${tabId}`];
  if (savedTask) await sendToTab(tabId, { type: 'TASK_RESUME', task: savedTask });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`task:${tabId}`).catch(() => {});
});
