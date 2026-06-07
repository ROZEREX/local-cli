# local-cli — web UI

A full browser front end for local-cli, served by Bun. It is **not** a rewrite:
it reuses the exact same agent core as the terminal (`../src/llm.ts`, the tools,
config, sessions, profiles, background servers, `ask_user`, everything). The
terminal CLI and this web UI are two faces of the same engine.

Built with **Tailwind** (via the Play CDN) + **lucide** icons, with animations
and loaders. No build step, no Node — just Bun.

```
ui-web/
  server.ts        Bun.serve: REST endpoints + a /ws WebSocket bridged to chat()
  public/
    index.html     app shell (Tailwind config + lucide)
    styles.css     small complement (markdown prose, scrollbars, caret)
    app.js         the SPA: streaming chat, sidebar, modals, controls
```

## Run

```bash
bun run web        # from the project root  (or: bun run ui-web/server.ts)
```

Open **http://localhost:4317** (set `PORT` to change it).

## Feature parity with the terminal
- **Chats** — persistent sessions per folder in the sidebar: new / switch / delete,
  auto-saved after every turn (same store as the CLI's `/resume`).
- **Folders** — click the working-folder card to browse and change the working
  directory (project-scoped, like `/cwd`).
- **Models** — switch from the header; the **ℹ️ model details** modal shows
  parameters, quantization, family, native context length, and capabilities. The
  context window auto-adapts to the model on switch.
- **Modes** — normal / plan / auto-accept toggle. In plan mode the agent proposes
  a plan and an **Approve & build** button appears.
- **Profiles** — list, switch active, view, delete, and **Learn** a new coding
  profile from the current project.
- **Background servers** — a panel lists `run_server` processes with status + URL,
  live logs, and a stop button.
- **Context** — a live used/limit (%) meter; a **compact** button to shrink history.
- **Attach files** — a file browser to add files/folders to the conversation context.
- **Reasoning** — `<think>` shown dimmed; a toggle to turn it on/off.
- **Permissions & ask_user** — mutating tools prompt with Allow/Deny; `ask_user`
  renders an interactive option picker — exactly like the terminal.
- **Tools** — every tool call is a card with an icon, a one-line summary, a live
  loader, and expandable output.

## How it connects
The browser opens a WebSocket to `server.ts`, which runs the normal `chat()` loop
and forwards every callback (`onText`, `onToolCall`, `requestPermission`, …) as a
JSON event. Clicks (allow/deny, choices, mode, model, folder…) are sent back and
resolve the corresponding promise inside the agent loop, so everything behaves
identically to the CLI. Each browser tab is one live conversation.
