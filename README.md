# Voice Navigator

Voice Navigator is a Chrome extension that guides a person through browser
tasks with voice. It uses AssemblyAI for live transcription and keeps a
per-tab task state instead of stopping after the first highlighted control.

## How it works

A completed voice request becomes a goal with a step history. The content
script inspects the current DOM, highlights one safe next action, and waits
for the user to click or edit. Trusted clicks and inputs advance the task.
Route changes and dynamically rendered menus cause the task to be resumed and
planned again on the new page.

The built-in DOM planner supports these GitHub workflows:

- create a repository, including asking for its name and filling the name
- create a file, including file name, contents, and commit
- edit a README, including opening the file, editing, and committing
- upload files, leaving local file selection to the user and continuing to
  the commit step

The semantic planner is the universal path: it receives the current page
snapshot on every step and chooses the next action for any domain. The local
planner remains as an offline fallback for common controls and the built-in
GitHub workflows, but it is not sufficient for arbitrary apps by itself.

## Requirements

1. Node.js 18 or newer
2. Google Chrome
3. An AssemblyAI API key
4. A microphone

## Project structure

```
voice-navigator/
├── README.md
├── backend/
│   ├── package.json
│   ├── .env.example
│   └── server.js
└── extension/
    ├── manifest.json
    ├── background.js
    ├── offscreen.html
    ├── offscreen.js
    ├── content.js
    ├── match.js
    ├── popup.html
    ├── popup.js
    └── styles.css
```

## Setup

```bash
cd voice-navigator/backend
npm install
cp .env.example .env
```

Set the AssemblyAI key in `backend/.env`:

```
ASSEMBLYAI_API_KEY=paste_your_assemblyai_key_here
```

Then run:

```bash
npm start
```

Keep this server running while using the extension.

### Universal semantic planning

The recommended setup is a local Ollama model. It avoids OpenAI free-tier
limits and keeps the page snapshot on your machine:

```
NAVIGATOR_AI_PROVIDER=ollama
NAVIGATOR_AI_BASE_URL=http://127.0.0.1:11434
NAVIGATOR_MODEL=qwen2.5:7b-instruct
```

Install Ollama from `ollama.com`, then run:

```bash
ollama pull qwen2.5:7b-instruct
ollama serve
```

The planner receives the spoken goal, non-sensitive answers, a bounded page
snapshot, and recent step labels. It returns one next action at a time and
replans after every page transition. Passwords, payment details,
authentication codes, and local file selection remain user-controlled.

The backend also supports OpenAI-compatible providers by changing
`NAVIGATOR_AI_PROVIDER`, `NAVIGATOR_AI_BASE_URL`, `NAVIGATOR_MODEL`, and
`NAVIGATOR_AI_API_KEY`. OpenAI is not required.

## Load the extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `voice-navigator/extension`.

The first time, open the extension popup and choose the microphone setup link.
Allow microphone access on the visible setup page.

## Use it

1. Start the backend.
2. Open a site where you are already signed in.
3. Start Listening from the extension popup.
4. Say the whole goal, such as:

   - "Create a new repository"
   - "Create a new file called app.js with a hello world program"
   - "Edit my README and add installation instructions"

5. Follow the highlighted control. The task stays active after clicks, menus,
   forms, and page transitions. When asked a question, answer naturally.
   Enter passwords and choose local files directly, then say "continue".

Click Stop Listening when finished. This also releases the microphone and
clears the task for the active tab.

## Troubleshooting

| Problem | Likely cause |
|---|---|
| Could not reach localhost:3000 | The backend is not running. |
| Microphone access was blocked | Run the one-time microphone setup again and check Chrome microphone permissions. |
| Token or 401 error | The AssemblyAI key is missing or invalid. |
| The task asks you to scroll | The next control is not in the visible interactive DOM yet. Scroll or open the menu, then say "continue". |
| An unfamiliar app stops at a generic question | Make sure Ollama is running, the model is pulled, and the backend is restarted. |
| A password or file picker is not automated | This is intentional. Complete those sensitive steps yourself. |

## Safety and limits

This is a guided browser assistant, not an unrestricted autonomous agent. It
does not bypass authentication, read passwords, select local files, or claim
success without a visible completion signal. The semantic planner is generic,
but site redesigns, CAPTCHAs, permissions, and app-specific behavior can still
require a user decision or a dedicated adapter for production-grade
reliability.

## Engineering notes

The audio pipeline still uses `ScriptProcessorNode` because it is simple and
works in Chrome's offscreen document. An `AudioWorkletNode` would be the next
audio reliability upgrade. The planner already has a clear boundary for
adding app-specific selectors and verification rules later.