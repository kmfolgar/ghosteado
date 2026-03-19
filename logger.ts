/**
 * logger.ts
 * Persists blocked access attempts to .ghosteado/access.log.json
 * inside the workspace root. Provides query helpers for the UI.
 */

import * as fs from "fs";
import * as path from "path";

export interface AccessEvent {
  timestamp: string;   // ISO-8601
  filePath: string;    // absolute path that was blocked
  operation: string;   // "readFile" | "readDirectory" | "stat"
  folder: string;      // which protected folder it belongs to
}

const LOG_DIR  = ".ghosteado";
const LOG_FILE = "access.log.json";

function logPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, LOG_DIR, LOG_FILE);
}

export function ensureLogDir(workspaceRoot: string): void {
  const dir = path.join(workspaceRoot, LOG_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Write a .gitignore inside .ghosteado so logs are never committed
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n", "utf8"); // keeps logs out of git
}

export function appendEvent(workspaceRoot: string, event: AccessEvent): void {
  try {
    ensureLogDir(workspaceRoot);
    const lp = logPath(workspaceRoot);
    const existing: AccessEvent[] = readLog(workspaceRoot);
    existing.push(event);
    // Keep last 500 events only
    const trimmed = existing.slice(-500);
    fs.writeFileSync(lp, JSON.stringify(trimmed, null, 2), "utf8");
  } catch {
    // Never let logging crash the extension
  }
}

export function readLog(workspaceRoot: string): AccessEvent[] {
  try {
    const lp = logPath(workspaceRoot);
    if (!fs.existsSync(lp)) return [];
    const raw = fs.readFileSync(lp, "utf8");
    return JSON.parse(raw) as AccessEvent[];
  } catch {
    return [];
  }
}

export function clearLog(workspaceRoot: string): void {
  try {
    const lp = logPath(workspaceRoot);
    if (fs.existsSync(lp)) fs.writeFileSync(lp, "[]", "utf8");
  } catch { /* ignore */ }
}

export function recentEvents(workspaceRoot: string, n = 10): AccessEvent[] {
  return readLog(workspaceRoot).slice(-n).reverse();
}
