const btn = document.getElementById('grantBtn');
const status = document.getElementById('status');

btn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed this to trigger (and record) the permission grant —
    // the actual capture for real use happens later, in offscreen.js.
    stream.getTracks().forEach((t) => t.stop());

    status.style.color = '#16a34a';
    status.textContent =
      '✅ Microphone access granted. You can close this tab now and use the extension normally — click the extension icon → Start Listening on any page.';
  } catch (err) {
    status.style.color = '#dc2626';
    status.textContent =
      '❌ Microphone access was blocked (' + err.message + '). ' +
      'Check chrome://settings/content/microphone for a blocked entry for this extension, remove it, then try again.';
  }
});
