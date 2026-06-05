import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export interface Session {
  id: string;
  title: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  history: ChatCompletionMessageParam[];
}

export type SessionMeta = Omit<Session, "history"> & { messageCount: number };

// Sessions are grouped per working directory so resuming is project-scoped.
function projectKey(cwd: string): string {
  return createHash("sha1").update(cwd.toLowerCase()).digest("hex").slice(0, 12);
}

function sessionsDir(cwd: string): string {
  return join(homedir(), ".local-cli", "sessions", projectKey(cwd));
}

export function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function deriveTitle(history: ChatCompletionMessageParam[]): string {
  const firstUser = history.find(m => m.role === "user");
  const text = typeof firstUser?.content === "string" ? firstUser.content : "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine || "untitled";
}

export function saveSession(session: Session): void {
  const dir = sessionsDir(session.cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
}

export function listSessions(cwd: string): SessionMeta[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const metas: SessionMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf-8")) as Session;
      const { history, ...meta } = s;
      metas.push({ ...meta, messageCount: history.filter(m => m.role === "user" || m.role === "assistant").length });
    } catch {
      /* skip corrupt */
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteSession(cwd: string, id: string): boolean {
  const fp = join(sessionsDir(cwd), `${id}.json`);
  try { if (existsSync(fp)) { unlinkSync(fp); return true; } } catch { /* ignore */ }
  return false;
}

export function loadSession(cwd: string, id: string): Session | null {
  const fp = join(sessionsDir(cwd), `${id}.json`);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, "utf-8")) as Session;
  } catch {
    return null;
  }
}

export function latestSession(cwd: string): Session | null {
  const metas = listSessions(cwd);
  return metas[0] ? loadSession(cwd, metas[0].id) : null;
}
