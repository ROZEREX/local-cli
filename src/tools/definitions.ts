import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns the file content with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file" },
          offset: { type: "number", description: "Line number to start reading from (1-based, optional)" },
          limit: { type: "number", description: "Number of lines to read (optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, creating it (and any parent directories recursively) if they do not exist. Overwrites existing content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact string in a file with new content. The old_string must match exactly including whitespace and indentation.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file" },
          old_string: { type: "string", description: "The exact text to find and replace" },
          new_string: { type: "string", description: "The replacement text" },
          replace_all: { type: "boolean", description: "Replace all occurrences (default: false)" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_files",
      description: "Find files matching a glob pattern. Returns a list of matching file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. 'src/**/*.ts', '*.json')" },
          cwd: { type: "string", description: "Directory to search in (defaults to current working directory)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for" },
          path: { type: "string", description: "File or directory to search in (defaults to cwd)" },
          glob: { type: "string", description: "Glob filter for file types (e.g. '*.ts')" },
          case_insensitive: { type: "boolean", description: "Case-insensitive search" },
          context: { type: "number", description: "Lines of context around each match" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories in a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to list (defaults to cwd)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a shell command and return its output. Use for running scripts, package managers, git, compilers, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          cwd: { type: "string", description: "Working directory for the command" },
          timeout: { type: "number", description: "Timeout in milliseconds. Defaults to 120000 (2 min), or 300000 (5 min) for installs/builds. Raise it for unusually long commands." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to delete" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_server",
      description: "Start a LONG-RUNNING process in the background (dev server, watcher, host) that keeps running after this call returns. Use this — NOT bash — for things like 'npm run dev', 'bun run dev', 'php -S', 'vite', 'next dev'. Returns a server id and the startup output (so you can see the URL/port or an early crash). bash is for commands that finish; run_server is for things that stay up.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command that starts the server (e.g. 'npm run dev')" },
          cwd: { type: "string", description: "Working directory (defaults to the project root)" },
          wait: { type: "number", description: "Milliseconds to wait for startup output before returning (default 2500, max 15000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "server_logs",
      description: "Read recent output (stdout+stderr) from a background server started with run_server. Use this to check whether it's serving correctly or to see runtime errors so you can fix them.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Server id (defaults to the most recently started server)" },
          lines: { type: "number", description: "How many recent lines to return (default 80)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_server",
      description: "Stop a background server started with run_server.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Server id (defaults to the most recently started server)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_servers",
      description: "List all background servers started this session, with their status, URL, and command.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Ask the user to make a decision when something is genuinely ambiguous and you cannot infer the answer — e.g. which package manager (bun/npm/pnpm/yarn), framework, or language to use, or whether to overwrite vs merge. Shows an interactive picker and returns their choice. Prefer this over guessing or proceeding silently. Don't ask about things you can detect yourself.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          options: { type: "array", items: { type: "string" }, description: "The choices to offer (2-6 short options)" },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_ports",
      description: "List the TCP ports currently being listened on, with the PID and process name for each. Use this to see what's occupying a port (e.g. when a dev server fails to start because the port is already in use).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_port",
      description: "Free a TCP port by killing whatever process is listening on it. Use this when a port is already in use (EADDRINUSE) and you need to start a server on it — then run the server again.",
      parameters: {
        type: "object",
        properties: { port: { type: "number", description: "The port number to free (e.g. 3000)" } },
        required: ["port"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_open",
      description: "Open a URL in a real browser the agent controls (launches Chrome/Edge if needed). Use this to open and TEST a web app you built or started with run_server, e.g. http://localhost:3000.",
      parameters: { type: "object", properties: { url: { type: "string", description: "URL to open" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_read",
      description: "Read the visible text of the current browser page, plus any console errors. Use this to verify a page rendered or to read error messages.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click an element in the current browser page by CSS selector or visible text (e.g. a button or link), to interact with the app.",
      parameters: { type: "object", properties: { target: { type: "string", description: "CSS selector or visible text of the element to click" } }, required: ["target"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "Take a screenshot of the current browser page and have a vision model describe it — so you can SEE whether the UI looks right or is broken. Optionally pass a specific question.",
      parameters: { type: "object", properties: { question: { type: "string", description: "What to look for (optional)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description: "Close the browser the agent is controlling.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Capture the user's screen and have a vision model analyze it — use when the user asks you to look at what they're doing or what's on their screen. Requires a vision-capable model.",
      parameters: { type: "object", properties: { question: { type: "string", description: "What to look at / analyze (optional)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "page_read",
      description: "Read the page the user is currently looking at, through the browser extension (their live tab). Returns the visible text plus a list of clickable elements. Use this to understand a real site the user wants you to work with (e.g. a marketplace).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "page_find",
      description: "Find and HIGHLIGHT elements on the user's live page that match some text, so the user can see what you mean. Returns the matches.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Text to look for on the page" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "page_click",
      description: "Click an element on the user's live page by visible text or CSS selector. The extension animates the AI cursor to it and highlights it first, so the user sees the action.",
      parameters: { type: "object", properties: { target: { type: "string", description: "Visible text or CSS selector of the element to click" } }, required: ["target"] },
    },
  },
  {
    type: "function",
    function: {
      name: "page_highlight",
      description: "Highlight element(s) on the user's live page (visual emphasis, no click) so you can point at what you're referring to.",
      parameters: { type: "object", properties: { target: { type: "string", description: "Visible text or CSS selector" } }, required: ["target"] },
    },
  },
  {
    type: "function",
    function: {
      name: "page_scroll",
      description: "Scroll the user's live page (down/up/top/bottom) to reveal more content.",
      parameters: { type: "object", properties: { to: { type: "string", enum: ["down", "up", "top", "bottom"] } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "system_info",
      description: "Report the machine's hardware (CPU, RAM, GPU/VRAM) and recommend which local models will run well for coding, vision, and general use. Use when the user asks what their machine can run or which model to pull.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_profile",
      description: "Read the user's saved coding profile — their cross-project style and conventions (stack, naming, structure, practices). Use it to recall how they like things built.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Profile name (defaults to the active profile)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_profile",
      description: "Save durable coding conventions to the user's coding profile so they persist into FUTURE projects (not just this chat). Use this — not just a chat reply — whenever you learn or are told a lasting preference about how this user builds software (stack, directory/file naming, where API/server code lives, tooling, testing). Default mode appends one or more short rules.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The convention(s) to save, as short prescriptive markdown rules" },
          mode: { type: "string", enum: ["append", "replace"], description: "append (default) adds to the profile; replace overwrites it" },
          name: { type: "string", description: "Profile to write to (defaults to the active profile, or 'default')" },
        },
        required: ["content"],
      },
    },
  },
];
