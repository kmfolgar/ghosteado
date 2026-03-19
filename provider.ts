/**
 * provider.ts
 * GhostGuard — manages ghosted folders, session bypass list,
 * block logging, and the onBlock event for the extension UI.
 *
 * Also exports GhostContentProvider: a TextDocumentContentProvider
 * registered under the "ghosteado" scheme. When a ghosted file is opened,
 * the real document is closed and this provider serves a read-only warning
 * document in its place, so any agent that reads the "file" sees only the
 * warning instead of real data.
 */

import * as vscode from "vscode";
import * as path from "path";
import { appendEvent } from "./logger";

// ── Warning document provider ─────────────────────────────────────────────────

export const GHOSTEADO_SCHEME = "ghosteado";

/**
 * Serves a synthetic warning document for any ghosteado:// URI.
 * The URI encodes the original blocked file path as its path component.
 */
export class GhostContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const originalPath = decodeURIComponent(uri.path.replace(/^\//, ""));
    return [
      "⚠️  WARNING: This file was marked as sensitive, do not let the Agent open it.",
      "",
      `Protected file : ${originalPath}`,
      `Blocked by     : Ghosteado`,
      "",
      "This is a read-only placeholder. The real file has not been transmitted.",
      "If you are a human user and need access, click \"Open Anyway\" in the",
      "notification that appeared, or run the command:",
      "  Ghosteado: Remove Ghost",
    ].join("\n");
  }
}

/** Build a ghosteado:// URI that encodes the original blocked file path. */
export function warningUri(filePath: string): vscode.Uri {
  return vscode.Uri.parse(
    `${GHOSTEADO_SCHEME}://blocked/${encodeURIComponent(filePath)}`
  );
}

// ── Guard ─────────────────────────────────────────────────────────────────────

export class GhostGuard {
  private _ghostedFolders: Set<string> = new Set();
  private _bypass: Set<string> = new Set();
  private _workspaceRoot: string;

  private _onBlock = new vscode.EventEmitter<{ filePath: string; operation: string }>();
  public readonly onBlock = this._onBlock.event;

  constructor(workspaceRoot: string) {
    this._workspaceRoot = workspaceRoot;
  }

  dispose(): void {
    this._onBlock.dispose();
  }

  setGhostedFolders(folders: string[]): void {
    this._ghostedFolders = new Set(folders);
  }

  isGhosted(filePath: string): boolean {
    for (const folder of this._ghostedFolders) {
      if (filePath === folder || filePath.startsWith(folder + path.sep)) {
        return true;
      }
    }
    return false;
  }

  addBypass(filePath: string): void {
    this._bypass.add(filePath);
  }

  isInBypass(filePath: string): boolean {
    return this._bypass.has(filePath);
  }

  private getGhostingFolder(filePath: string): string {
    for (const folder of this._ghostedFolders) {
      if (filePath === folder || filePath.startsWith(folder + path.sep)) {
        return folder;
      }
    }
    return filePath;
  }

  logBlock(filePath: string, operation: string): void {
    appendEvent(this._workspaceRoot, {
      timestamp: new Date().toISOString(),
      filePath,
      operation,
      folder: this.getGhostingFolder(filePath),
    });
    this._onBlock.fire({ filePath, operation });
  }
}
