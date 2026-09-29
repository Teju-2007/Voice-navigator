// backend/server.js
//
// This tiny server has exactly one job: mint a short-lived AssemblyAI
// streaming token and hand it to the Chrome extension. Your permanent
// AssemblyAI API key stays here, in this .env file, on your machine —
// it never gets sent to the browser. The extension only ever sees the
// temporary token, which expires in a few minutes.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors()); // allow the extension (chrome-extension:// origin) to call this server
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const NAVIGATOR_AI_PROVIDER = (process.env.NAVIGATOR_AI_PROVIDER || 'ollama').toLowerCase();
const NAVIGATOR_AI_API_KEY = process.env.NAVIGATOR_AI_API_KEY;
const NAVIGATOR_AI_BASE_URL = (
  process.env.NAVIGATOR_AI_BASE_URL ||
  (NAVIGATOR_AI_PROVIDER === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1')
).replace(/\/$/, '');

app.get('/token', async (req, res) => {
  if (!API_KEY || API_KEY === 'your_assemblyai_api_key_here') {
    return res.status(500).json({
      error: 'ASSEMBLYAI_API_KEY is not set. Copy backend/.env.example to backend/.env and paste your real key in.'
    });
  }

  try {
    const response = await fetch(
      'https://streaming.assemblyai.com/v3/token?expires_in_seconds=300',
      { headers: { Authorization: API_KEY } }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error('AssemblyAI token request failed:', response.status, text);
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    res.json(data); // { token: "..." }
  } catch (err) {
    console.error('Token server error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Optional semantic planner. The extension still has a deterministic local
// planner when this key is not configured; this endpoint lets it understand
// unfamiliar apps and labels without putting an API key in the extension.
app.post('/plan', async (req, res) => {
  if (!NAVIGATOR_AI_API_KEY && NAVIGATOR_AI_PROVIDER !== 'ollama') {
    return res.status(503).json({ error: 'Configure a planner provider in backend/.env' });
  }

  const { goal, page, history = [], answers = {} } = req.body || {};
  if (!goal || !page) {
    return res.status(400).json({ error: 'goal and page are required' });
  }

  const system = `You are a universal browser task navigator. Turn a user's
goal, prior answers, recent actions, and the current page snapshot into exactly
one safe next step. The user may be on any website or web app. Use only
controls present in the snapshot and never invent labels, URLs, or success.
Return JSON only in this shape:
{"status":"continue|ask|complete","message":"short instruction",
"action":{"type":"click|type|focus|select|check|scroll","label":"exact visible label",
"value":"optional non-sensitive value"},"field":"optional answer key"}.
Use ask when information is missing, and use the exact field name when possible.
For a form, work through one field or submit control at a time. For menus,
first open the visible menu, then plan from the newly rendered controls. For
long pages, use scroll when the next relevant control is not visible. Never
ask for or handle passwords, payment numbers, authentication codes, or private
keys. Never claim completion unless the page clearly confirms it. Prefer one
user-visible action at a time.`;

  const prompt = JSON.stringify({ goal, answers, page, recentHistory: history.slice(-12) });
  try {
    const isOllama = NAVIGATOR_AI_PROVIDER === 'ollama';
    const response = await fetch(
      isOllama
        ? `${NAVIGATOR_AI_BASE_URL}/api/chat`
        : `${NAVIGATOR_AI_BASE_URL}/chat/completions`,
      {
      method: 'POST',
      headers: {
        ...(NAVIGATOR_AI_API_KEY
          ? { Authorization: `Bearer ${NAVIGATOR_AI_API_KEY}` }
          : {}),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        isOllama
          ? {
              model: process.env.NAVIGATOR_MODEL || 'qwen2.5:7b-instruct',
              stream: false,
              format: 'json',
              options: { temperature: 0.1 },
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt }
              ]
            }
          : {
              model: process.env.NAVIGATOR_MODEL || 'gpt-4o-mini',
              temperature: 0.1,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt }
              ]
            }
      )
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error || data });
    const content = isOllama
      ? data.message?.content
      : data.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'Planner returned no content' });
    res.json(JSON.parse(content));
  } catch (err) {
    console.error('Planner request failed:', err);
    res.status(502).json({ error: 'Planner request failed', detail: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Voice Navigator backend is running. The extension uses /token and /plan.');
});

app.listen(PORT, () => {
  console.log(`\n Voice Navigator token server running at http://localhost:${PORT}`);
  console.log(' Keep this window open while you use the extension.\n');
});
