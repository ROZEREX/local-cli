import "./test-config-setup";
import { executeTool } from "./src/tools/executor";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "localcli-test-"));
saveConfig({ cwd: dir });

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${detail}`); }
}

const run = async () => {
  // write_file
  let r = await executeTool("write_file", { path: "hello.txt", content: "line1\nline2\nline3\n" });
  check("write_file creates file", r.includes("Written"), r);

  // read_file
  r = await executeTool("read_file", { path: "hello.txt" });
  check("read_file returns numbered lines", r.includes("1\tline1") && r.includes("3\tline3"), r);

  // read_file with offset/limit
  r = await executeTool("read_file", { path: "hello.txt", offset: 2, limit: 1 });
  check("read_file offset+limit", r.trim() === "2\tline2", JSON.stringify(r));

  // edit_file unique
  r = await executeTool("edit_file", { path: "hello.txt", old_string: "line2", new_string: "EDITED" });
  check("edit_file replaces unique string", r.includes("Edited"), r);
  r = await executeTool("read_file", { path: "hello.txt" });
  check("edit_file persisted", r.includes("EDITED"), r);

  // edit_file ambiguous should fail without replace_all
  await executeTool("write_file", { path: "dup.txt", content: "x\nx\nx\n" });
  r = await executeTool("edit_file", { path: "dup.txt", old_string: "x", new_string: "y" });
  check("edit_file rejects ambiguous match", r.includes("matches 3 locations"), r);

  // edit_file replace_all
  r = await executeTool("edit_file", { path: "dup.txt", old_string: "x", new_string: "y", replace_all: true });
  check("edit_file replace_all works", r.includes("replaced 3"), r);

  // glob_files
  r = await executeTool("glob_files", { pattern: "*.txt" });
  check("glob_files finds files", r.includes("hello.txt") && r.includes("dup.txt"), r);

  // grep_files
  r = await executeTool("grep_files", { pattern: "EDITED" });
  check("grep_files finds match", r.includes("EDITED") && r.includes("hello.txt:2"), r);

  // grep_files case-insensitive
  r = await executeTool("grep_files", { pattern: "edited", case_insensitive: true });
  check("grep_files case-insensitive", r.includes("EDITED"), r);

  // list_dir
  r = await executeTool("list_dir", {});
  check("list_dir lists files", r.includes("hello.txt"), r);

  // bash
  r = await executeTool("bash", { command: "echo hello-from-bash" });
  check("bash runs command", r.includes("hello-from-bash"), r);

  // bash non-zero exit
  r = await executeTool("bash", { command: "exit 3" });
  check("bash reports non-zero exit", r.includes("Exit 3"), r);

  // bash timeout — a command that sleeps past a tiny explicit timeout returns a
  // clear "timed out" message, not a raw ETIMEDOUT.
  const isWin = process.platform === "win32";
  const sleepCmd = isWin ? "Start-Sleep -Seconds 5" : "sleep 5";
  r = await executeTool("bash", { command: sleepCmd, timeout: 400 });
  check("bash timeout returns a clear message", r.includes("timed out after") && !r.includes("ETIMEDOUT"), r);
  check("bash timeout suggests run_server for long-lived processes", r.includes("run_server"), r);

  if (isWin) {
    // bash Windows PowerShell tips
    r = await executeTool("bash", { command: "rm -rf fake-dir" });
    check("bash on Windows rm -rf command fails and shows PowerShell tip", r.includes("Windows PowerShell Tips") && r.includes("Remove-Item"), r);
  }

  // arg normalization — native tool calls may use aliases instead of "path"
  r = await executeTool("write_file", { file: "alias.txt", content: "via alias" });
  check("write_file accepts 'file' alias for path", r.includes("Written"), r);
  r = await executeTool("read_file", { filename: "alias.txt" });
  check("read_file accepts 'filename' alias for path", r.includes("via alias"), r);

  // delete_file
  r = await executeTool("delete_file", { path: "dup.txt" });
  check("delete_file removes file", r.includes("Deleted"), r);
  r = await executeTool("read_file", { path: "dup.txt" });
  check("delete_file actually deleted", r.includes("not found"), r);

  // error: read missing
  r = await executeTool("read_file", { path: "nope.txt" });
  check("read_file missing returns error", r.includes("not found"), r);

  // error: write_file missing content
  r = await executeTool("write_file", { path: "hello.txt" });
  check("write_file validation blocks missing content", r.includes("content was not provided"), r);

  // error: edit_file missing old_string
  r = await executeTool("edit_file", { path: "hello.txt", new_string: "EDITED" });
  check("edit_file validation blocks missing old_string", r.includes("old_string (search block) was not provided"), r);

  // error: edit_file missing new_string
  r = await executeTool("edit_file", { path: "hello.txt", old_string: "line1" });
  check("edit_file validation blocks missing new_string", r.includes("new_string (replace block) was not provided"), r);

  // error: read_file empty path
  r = await executeTool("read_file", { path: "" });
  check("read_file validation blocks empty path", r.includes("path is required"), r);

  // error: read_file directory path
  r = await executeTool("read_file", { path: "." });
  check("read_file validation blocks directory path", r.includes("Path is a directory"), r);

  // error: edit_file directory path
  r = await executeTool("edit_file", { path: ".", old_string: "foo", new_string: "bar" });
  check("edit_file validation blocks directory path", r.includes("Path is a directory"), r);

  // error: delete_file directory path
  r = await executeTool("delete_file", { path: "." });
  check("delete_file validation blocks directory path", r.includes("Path is a directory"), r);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
};

run();
