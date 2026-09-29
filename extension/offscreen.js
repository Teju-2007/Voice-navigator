// extension/offscreen.js
//
// This is the audio pipeline: microphone -> 16kHz PCM16 -> AssemblyAI
// real-time WebSocket -> live "Turn" transcripts sent back to the
// background script (which forwards them to content.js on the page).
//
// AssemblyAI's real-time transcripts arrive as they're being spoken —
// not after a full sentence — which is what lets content.js update the
// on-screen highlight before the user finishes talking.

const BACKEND_URL = 'http://localhost:3000';

let ws = null;
let audioContext = null;
let processor = null;
let source = null;
let mediaStream = null;
let silentOutput = null;
let stopping = false;

async function startCapture() {
  stopping = false;
  reportStatus('requesting-microphone', 'Requesting microphone access…');
  if (!navigator.mediaDevices?.getUserMedia) {
    reportError('This Chrome context does not expose microphone access. Use the visible microphone setup page first.');
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    reportStatus('microphone-ready', 'Microphone ready. Connecting to transcription…');
  } catch (err) {
    reportError(`Microphone access failed (${err.name || 'unknown error'}). Open the extension popup, complete "Set up microphone access", and try again.`);
    return;
  }

  let tokenData;
  try {
    const tokenRes = await fetch(`${BACKEND_URL}/token`, { cache: 'no-store' });
    tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.token) {
      reportError(tokenData.error || 'Could not get a token from the local backend. Is it running (npm start in backend/)?');
      return;
    }
  } catch (err) {
    reportError('Could not reach http://localhost:3000. Start the backend with "npm start" in backend/.');
    return;
  }

  // mode=min_latency trades a little accuracy for speed — that's what
  // makes the highlight feel like it's reacting instantly.
  const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=universal-3-5-pro&mode=min_latency&token=${tokenData.token}`;

  reportStatus('connecting', 'Microphone ready. Connecting to AssemblyAI…');
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    reportError(`Could not open the transcription connection (${err.message || 'WebSocket error'}).`);
    return;
  }
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('[Voice Navigator] connected to AssemblyAI streaming');
    try {
      setupAudioPipeline();
      reportStatus('listening', 'Listening for your voice…');
    } catch (err) {
      reportError(`Audio pipeline failed (${err.message || 'unknown error'}).`);
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'Turn') {
      reportStatus('listening', 'Listening for your voice…');
      // "transcript" holds all finalized words in the current turn as
      // they land — this is the live-updating text we match against.
      chrome.runtime.sendMessage({
        type: 'TURN_UPDATE',
        transcript: msg.transcript,
        endOfTurn: msg.end_of_turn
      });
    }
  };

  ws.onerror = (err) => {
    console.error('[Voice Navigator] WebSocket error:', err);
    if (!stopping) reportError('AssemblyAI closed the transcription connection. Check the AssemblyAI key and network connection.');
  };

  ws.onclose = () => {
    console.log('[Voice Navigator] WebSocket closed');
    if (!stopping) reportError('The transcription connection closed before listening finished.');
  };
}

function setupAudioPipeline() {
  // Creating the AudioContext at 16000Hz makes the browser resample the
  // mic's native audio to the rate AssemblyAI expects.
  audioContext = new AudioContext({ sampleRate: 16000 });
  source = audioContext.createMediaStreamSource(mediaStream);

  // ScriptProcessorNode is deprecated but is the simplest option that
  // works reliably inside an offscreen document. AudioWorklet is the
  // production upgrade — see README "Next steps".
  processor = audioContext.createScriptProcessor(4096, 1, 1);

  source.connect(processor);
  // ScriptProcessorNode needs an output connection to keep processing, but
  // sending microphone audio to the real destination creates feedback. A
  // silent gain node keeps the callback alive without playing the mic.
  silentOutput = audioContext.createGain();
  silentOutput.gain.value = 0;
  processor.connect(silentOutput);
  silentOutput.connect(audioContext.destination);

  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    try {
      ws.send(floatTo16BitPCM(input));
    } catch (err) {
      reportError(`Audio data could not be sent (${err.message || 'WebSocket error'}).`);
    }
  };
}

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function stopCapture() {
  stopping = true;
  if (processor) { processor.disconnect(); processor = null; }
  if (source) { source.disconnect(); source = null; }
  if (silentOutput) { silentOutput.disconnect(); silentOutput = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (ws) { ws.close(); ws = null; }
}

function reportError(message) {
  console.error('[Voice Navigator]', message);
  chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', message }).catch(() => {});
}

function reportStatus(status, message) {
  chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS', status, message }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'BEGIN_CAPTURE') {
    startCapture();
  }
  if (message.type === 'END_CAPTURE') {
    stopCapture();
  }
});
