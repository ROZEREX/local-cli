# local-cli — browser extension (live page agent)

A floating chat that rides along on whatever page you're viewing and lets your
local-cli agent **see, highlight, and click** things on it — with a visible AI
cursor and highlights, so you watch it work. Ask it "find the cheapest item",
"fill this form", "click the login button", etc.

It connects to the same `bun run web` server as the web UI (no separate backend).

## Install (one-time, ~30s)

Chrome won't let an **unpublished** extension install with a single click — that
requires the Chrome Web Store (a paid dev account + review). So for now it's
"load unpacked", which you do once:

1. Start the server: **`bun run web`** (from the project root).
2. Open **chrome://extensions** (or edge://extensions).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select this `extension/` folder.

That's it — it stays installed. The dot in the panel header (and the **live
browser** badge in the web UI header) turns green when it's connected.

## Two ways to use it
- **From the main web chat** (`http://localhost:4317`): once the badge says *live
  browser*, just ask — "open amazon.com and find the cheapest mechanical
  keyboard". The agent uses **page_open** to open a tab and acts on it; you watch
  the AI cursor + highlights.
- **From the floating panel** on any page: click the **◆ bubble** (bottom-right) or
  the toolbar icon, and chat right there about the page you're on.

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
