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
          timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
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
];
