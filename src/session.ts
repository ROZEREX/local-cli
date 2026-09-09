import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { createHash } from "crypto";
import { isIncognito } from "./incognito";
import { configDir } from "./config";
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
  return join(configDir(), "sessions", projectKey(cwd));
}

// Session IDs become filenames, so accept only the portable subset produced by
// newSessionId (plus `_` for forwards compatibility). In particular, separators,
// dots, drive prefixes and encoded traversal shapes never reach fs operations.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

function sessionFilePath(cwd: string, id: unknown): string | null {
  if (!isValidSessionId(id)) return null;
  const dir = resolve(sessionsDir(cwd));
  const fp = resolve(dir, `${id}.json`);
  const rel = relative(dir, fp);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) return null;
  return fp;
}

function isSessionForProject(value: unknown, cwd: string, expectedId: string): value is Session {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<Session>;
  return s.id === expectedId
    && typeof s.cwd === "string"
    && projectKey(s.cwd) === projectKey(cwd)
    && typeof s.title === "string"
    && typeof s.model === "string"
    && typeof s.createdAt === "number"
    && typeof s.updatedAt === "number"
    && Array.isArray(s.history);
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
  if (isIncognito()) return; // incognito conversations never touch the disk
  const dir = sessionsDir(session.cwd);
  const fp = sessionFilePath(session.cwd, session.id);
  if (!fp) throw new Error(`Invalid session id: ${JSON.stringify(session.id)}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fp, JSON.stringify(session, null, 2));
}

export function listSessions(cwd: string): SessionMeta[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const metas: SessionMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    const fp = sessionFilePath(cwd, id);
    if (!fp) continue;
    try {
      const value = JSON.parse(readFileSync(fp, "utf-8"));
      if (!isSessionForProject(value, cwd, id)) continue;
      const s = value;
      const { history, ...meta } = s;
      metas.push({ ...meta, messageCount: history.filter(m => m.role === "user" || m.role === "assistant").length });
    } catch {
      /* skip corrupt */
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteSession(cwd: string, id: string): boolean {
  const fp = sessionFilePath(cwd, id);
  if (!fp) return false;
  try { if (existsSync(fp)) { unlinkSync(fp); return true; } } catch { /* ignore */ }
  return false;
}

export function loadSession(cwd: string, id: string): Session | null {
  const fp = sessionFilePath(cwd, id);
  if (!fp) return null;
  if (!existsSync(fp)) return null;
  try {
    const value = JSON.parse(readFileSync(fp, "utf-8"));
    return isSessionForProject(value, cwd, id) ? value : null;
  } catch {
    return null;
  }
}

export function latestSession(cwd: string): Session | null {
  const metas = listSessions(cwd);
  return metas[0] ? loadSession(cwd, metas[0].id) : null;
}
