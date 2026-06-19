# local-cli — browser extension (live page agent)

This extension lets the agent work on **the page you are actually looking at** —
your real browser, your real session, logins included. You watch it work: an
animated **AI cursor** glides to each element with a small `click`/`type` label,
and everything it touches gets a **highlight box**.

> There are TWO ways the agent uses browsers — don't confuse them:
>
> | | What it is | Setup | Best for |
> |---|---|---|---|
> | **Agent's own browser** (`browser_*` tools) | A separate Chrome window the agent launches and controls | none | testing apps it builds (`localhost`) |
> | **Your live browser** (`page_*` tools, THIS extension) | The tab you're viewing right now | install once, below | real sites: shopping, forms, research |
>
> Ask `/browser` in the CLI (or click the **?** in the web UI's Browser tab) for
> this guide any time.

## Install (one-time, ~30 seconds)

Chrome doesn't allow one-click installs for unpublished extensions, so it's
"load unpacked" — once:

1. Start the server: **`bun run web`** (from the project root).
2. Open **chrome://extensions** (or edge://extensions).
3. Toggle on **Developer mode** (top-right).
4. Click **Load unpacked** → select this `extension/` folder.

**How to know it's connected:** the ◆ bubble's header dot turns **green**, and
the web UI header shows a green **live browser** badge.

## How to use it

**Option A — from the main web chat** (`http://localhost:4317`):
once the *live browser* badge is green, just ask in plain language:

- *"open amazon.com and find the cheapest mechanical keyboard under $50"*
- *"read this page and summarize the reviews"* (with the tab you're on)
- *"fill the signup form with test data"*

**Option B — from the floating panel on any page:** click the **◆ bubble**
(bottom-right of any page) or the extension's toolbar icon, and chat right
there. The panel shows the model's live **thinking**, a status line (loading /
reading / running a tool), and the conversation.

## What you'll see while it works

- The **AI cursor** (blue arrow) glides to the element it's about to use, with a
  `click` or `type` label next to it.
- **Highlight boxes** flash around elements it reads, finds, or acts on.
- `page_find` highlights every match at once — that's the agent "pointing".
- In the chat, the agent narrates each step in one short sentence.

## What it can do on a page

| Tool | What it does |
|---|---|
| `page_open` / `page_navigate` | open a new tab / change this tab's URL |
| `page_read` | read visible text + list the clickable elements |
| `page_find` | find text on the page and **highlight** the matches |
| `page_click` | move the cursor to an element, highlight, click |
| `page_type` | fill an input or textarea |
| `page_highlight` | point at something without clicking |
| `page_scroll` | scroll down/up/top/bottom |

The agent picks these itself — you never call them directly.

## Safety

- In **normal** mode the agent asks permission before every click/type.
- In **auto** mode it acts on its own. Clicks are REAL — be careful on pages
  with purchases, payments, or destructive forms.
- It always confirms with you before anything irreversible (submitting orders,
  payments, deletions).

## Troubleshooting

- **Dot stays red:** is `bun run web` running? The worker scans ports
  4317–4321; if your server ended up elsewhere, edit `PORTS` at the top of
  `background.js`.
- **Panel doesn't appear:** the page may block content scripts
  (chrome:// pages, the Web Store). Try a regular website.
- **Stopped responding after an update:** reload the extension in
  chrome://extensions (↻ on the card), then refresh the page.

## How it's wired (for the curious)

`content.js` (panel + cursor + command executor on the page)
↔ `background.js` (MV3 worker — the only part allowed to open the
`ws://localhost:4317/ext` socket) ↔ the local-cli server's `/ext` endpoint
(`src/extbridge.ts`) ↔ the agent's `page_*` tools. Same `chat()` loop as the
CLI and web UI.
