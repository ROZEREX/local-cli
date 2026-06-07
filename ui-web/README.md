# local-cli — web UI

A browser front end for local-cli, served by Bun. It is **not** a rewrite: it
reuses the exact same agent core as the terminal (`../src/llm.ts`, the tools,
config, profiles, background servers, `ask_user`, everything). The terminal CLI
and this web UI are two faces of the same engine — use whichever you like.

```
ui-web/
  server.ts        Bun.serve: static files + a /ws WebSocket bridged to chat()
  public/
    index.html     app shell
    styles.css     Tokyo-Night theme (no purple)
    app.js         streaming chat UI (text, <think>, tool cards, permissions)
```

## Run

```bash
bun run web        # from the project root
# or:  bun run ui-web/server.ts
```

Then open **http://localhost:4317** (set `PORT` to change it).

It operates on the same working directory as your CLI config
(`~/.local-cli/config.json` → `cwd`) and uses the same model. Switch models from
the header; the context window adapts to the model's native limit automatically.

## What works
- Streaming responses with markdown + dimmed `<think>` reasoning
- Per-tool cards (click to expand output) for every tool the agent runs
- Permission prompts (Allow / Deny) for mutating tools, and `ask_user` pickers
- Live token counter + tok/s while generating; context-usage meter in the header
- New chat, model switcher, Stop button

## How it connects
The browser opens a WebSocket to `server.ts`, which runs the normal `chat()`
loop and forwards every callback (`onText`, `onToolCall`, `requestPermission`, …)
as a JSON event. User clicks (allow/deny, choices) are sent back and resolve the
corresponding promise inside the agent loop — so permissions and `ask_user` work
exactly like they do in the terminal.

> MVP scope: one conversation per browser tab (in-memory). Sessions, plan/
> auto-accept modes, file pickers, and diff previews are on the CLI today and can
> be ported here next.
