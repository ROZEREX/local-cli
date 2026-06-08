# local-cli — browser extension (live page agent)

A floating chat that rides along on whatever page you're viewing and lets your
local-cli agent **see, highlight, and click** things on it — with a visible AI
cursor and highlights, so you watch it work. Ask it "find the cheapest item",
"fill this form", "click the login button", etc.

It connects to the same `bun run web` server as the web UI (no separate backend).

## Install (load unpacked — takes 30s)

1. Start the server: **`bun run web`** (from the project root).
2. Open **chrome://extensions** (or edge://extensions).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this `extension/` folder.
5. Open any web page. A **◆ bubble** appears bottom-right — click it for the chat.
   (Or click the extension's toolbar icon to toggle it.)

The dot in the panel header is green when it's connected to the server.

## What it can do on the page
- **page_read** — read the visible text + clickable elements (so the agent
  understands the page).
- **page_find** — find & **highlight** matching elements for you.
- **page_click** — move the **AI cursor** to an element, highlight it, and click —
  you see exactly what it's doing.
- **page_highlight** — point at something without clicking.
- **page_scroll** — scroll to reveal more.

The agent decides when to use these. In **auto** mode it acts on its own; in
**normal** mode it asks before clicking (a safeguard for forms/purchases).

## How it's wired
`content.js` (the panel + cursor + executor) ↔ `background.js` (the only part
allowed to open a `ws://localhost:4317/ext` socket) ↔ the local-cli server's
`/ext` endpoint ↔ the agent's `page_*` tools (`src/extbridge.ts`). The agent runs
the SAME `chat()` loop as everywhere else.

> Notes: the WS URL is `ws://localhost:4317/ext`. If you run the server on another
> port, update `WS_URL` in `background.js`. Be careful in **auto** mode on pages
> with real purchases/forms — clicks are real.
