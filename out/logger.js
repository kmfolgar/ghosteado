"use strict";
/**
 * logger.ts
 * Persists blocked access attempts to .ghosteado/access.log.json
 * inside the workspace root. Provides query helpers for the UI.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureLogDir = ensureLogDir;
exports.appendEvent = appendEvent;
exports.readLog = readLog;
exports.clearLog = clearLog;
exports.recentEvents = recentEvents;
const fs = require("fs");
const path = require("path");
const LOG_DIR = ".ghosteado";
const LOG_FILE = "access.log.json";
function logPath(workspaceRoot) {
    return path.join(workspaceRoot, LOG_DIR, LOG_FILE);
}
function ensureLogDir(workspaceRoot) {
    const dir = path.join(workspaceRoot, LOG_DIR);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    // Write a .gitignore inside .ghosteado so logs are never committed
    const gi = path.join(dir, ".gitignore");
    if (!fs.existsSync(gi))
        fs.writeFileSync(gi, "*\n", "utf8"); // keeps logs out of git
}
function appendEvent(workspaceRoot, event) {
    try {
        ensureLogDir(workspaceRoot);
        const lp = logPath(workspaceRoot);
        const existing = readLog(workspaceRoot);
        existing.push(event);
        // Keep last 500 events only
        const trimmed = existing.slice(-500);
        fs.writeFileSync(lp, JSON.stringify(trimmed, null, 2), "utf8");
    }
    catch {
        // Never let logging crash the extension
    }
}
function readLog(workspaceRoot) {
    try {
        const lp = logPath(workspaceRoot);
        if (!fs.existsSync(lp))
            return [];
        const raw = fs.readFileSync(lp, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
function clearLog(workspaceRoot) {
    try {
        const lp = logPath(workspaceRoot);
        if (fs.existsSync(lp))
            fs.writeFileSync(lp, "[]", "utf8");
    }
    catch { /* ignore */ }
}
function recentEvents(workspaceRoot, n = 10) {
    return readLog(workspaceRoot).slice(-n).reverse();
}
//# sourceMappingURL=logger.js.map