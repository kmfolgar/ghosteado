"use strict";
/**
 * provider.ts
 * GhostGuard — manages ghosted folders, session bypass list,
 * block logging, and the onBlock event for the extension UI.
 *
 * Also exports GhostContentProvider: a TextDocumentContentProvider
 * registered under the "ghosteado" scheme. When a protected host path is
 * opened directly in VS Code, Ghosteado can replace the editor tab with a
 * warning document that tells the user to resume inside the container.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GhostGuard = exports.GhostContentProvider = exports.GHOSTEADO_SCHEME = void 0;
exports.warningUri = warningUri;
const vscode = require("vscode");
const path = require("path");
const logger_1 = require("./logger");
// ── Warning document provider ─────────────────────────────────────────────────
exports.GHOSTEADO_SCHEME = "ghosteado";
/**
 * Serves a synthetic warning document for any ghosteado:// URI.
 * The URI encodes the original blocked file path as its path component.
 */
class GhostContentProvider {
    provideTextDocumentContent(uri) {
        const originalPath = decodeURIComponent(uri.path.replace(/^\//, ""));
        return [
            "👻 WARNING: This protected dataset path was opened on the host.",
            "",
            `Protected file : ${originalPath}`,
            `Blocked by     : Ghosteado`,
            "",
            "Use Ghosteado's container workflow for AI-assisted work.",
            "If you need the host file directly, choose \"Open Anyway\" from the warning",
            "notification or remove data protection from this dataset.",
        ].join("\n");
    }
}
exports.GhostContentProvider = GhostContentProvider;
/** Build a ghosteado:// URI that encodes the original blocked file path. */
function warningUri(filePath) {
    return vscode.Uri.parse(`${exports.GHOSTEADO_SCHEME}://blocked/${encodeURIComponent(filePath)}`);
}
// ── Guard ─────────────────────────────────────────────────────────────────────
class GhostGuard {
    constructor(workspaceRoot) {
        this._ghostedFolders = new Set();
        this._bypass = new Set();
        this._onBlock = new vscode.EventEmitter();
        this.onBlock = this._onBlock.event;
        this._workspaceRoot = workspaceRoot;
    }
    dispose() {
        this._onBlock.dispose();
    }
    setGhostedFolders(folders) {
        this._ghostedFolders = new Set(folders);
    }
    isGhosted(filePath) {
        for (const folder of this._ghostedFolders) {
            if (filePath === folder || filePath.startsWith(folder + path.sep)) {
                return true;
            }
        }
        return false;
    }
    addBypass(filePath) {
        this._bypass.add(filePath);
    }
    isInBypass(filePath) {
        return this._bypass.has(filePath);
    }
    getGhostingFolder(filePath) {
        for (const folder of this._ghostedFolders) {
            if (filePath === folder || filePath.startsWith(folder + path.sep)) {
                return folder;
            }
        }
        return filePath;
    }
    logBlock(filePath, operation) {
        (0, logger_1.appendEvent)(this._workspaceRoot, {
            timestamp: new Date().toISOString(),
            filePath,
            operation,
            folder: this.getGhostingFolder(filePath),
        });
        this._onBlock.fire({ filePath, operation });
    }
}
exports.GhostGuard = GhostGuard;
//# sourceMappingURL=provider.js.map