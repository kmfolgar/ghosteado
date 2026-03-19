/**
 * extension.ts — Ghosteado main entry point
 *
 * Architecture:
 *  - GhostGuard: tracks ghosted folders, bypass list, and fires onBlock events
 *  - GhostContentProvider: serves a read-only warning document (ghosteado://)
 *    that replaces a blocked file in the editor so agents see a warning, not real data
 *  - onDidOpenTextDocument: intercepts every file opened in an editor tab;
 *    ghosted files are immediately closed and replaced with the warning document
 *  - search.exclude: added to workspace settings so agents cannot discover ghosted
 *    folders via VS Code's file-search APIs
 *  - Ignore files: .copilotignore / .cursorignore / etc. written inside and at root
 *  - Move records: .ghosteado/moves.json tracks data moved outside the workspace
 *    so unghost can move it back automatically
 *  - Setup Wizard: guided 4-step flow triggered from context menu or command palette
 *  - AccessLogger: persists blocked attempts to .ghosteado/access.log.json
 *  - Simulator: placeholder CSV + AI pre-prompt .md files in _simulated/ subfolders
 *  - StatusBar: live count of blocked attempts + ghosted folder count
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  GhostGuard,
  GhostContentProvider,
  GHOSTEADO_SCHEME,
  warningUri,
} from "./provider";
import { clearLog, recentEvents, ensureLogDir } from "./logger";
import { simulateCsv, inferColType, generateAIPrompt } from "./simulator";
import { runSetupWizard, ScriptLanguage } from "./wizard";
import { runContainerWizard, runContainerStep } from "./devcontainer";

// ── Globals ───────────────────────────────────────────────────────────────────

let guard: GhostGuard;
let statusBarItem: vscode.StatusBarItem;
let blockCount = 0;

// ── Activate ──────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspaceRoot) {
    const noWorkspace = () =>
      vscode.window.showWarningMessage("Ghosteado: Open a workspace folder first.");
    context.subscriptions.push(
      vscode.commands.registerCommand("ghosteado.protectFolder", noWorkspace),
      vscode.commands.registerCommand("ghosteado.unprotectFolder", noWorkspace),
      vscode.commands.registerCommand("ghosteado.showStatus", noWorkspace),
      vscode.commands.registerCommand("ghosteado.clearLog", noWorkspace),
      vscode.commands.registerCommand("ghosteado.regenerateSimulated", noWorkspace),
      vscode.commands.registerCommand("ghosteado.setupWizard", noWorkspace),
      vscode.commands.registerCommand("ghosteado.addContainerProtection", noWorkspace),
    );
    return;
  }

  ensureLogDir(workspaceRoot);

  // ── Guard + warning document provider ──────────────────────────────────────
  guard = new GhostGuard(workspaceRoot);
  loadGhostedFolders();
  context.subscriptions.push({ dispose: () => guard.dispose() });

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GHOSTEADO_SCHEME,
      new GhostContentProvider()
    )
  );

  // ── Status bar ──────────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    200
  );
  statusBarItem.command = "ghosteado.showStatus";
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // ── Intercept file opens ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (doc) => {
      if (doc.uri.scheme !== "file") return;
      const p = doc.uri.fsPath;
      if (!guard.isGhosted(p) || guard.isInBypass(p)) return;

      // Close every editor tab showing this document
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.fsPath === p
          ) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }

      // Open the warning placeholder in its place
      const wUri = warningUri(p);
      const wDoc = await vscode.workspace.openTextDocument(wUri);
      await vscode.window.showTextDocument(wDoc, { preview: true, preserveFocus: false });

      guard.logBlock(p, "open");

      const cfg = vscode.workspace.getConfiguration("ghosteado");
      const mode: string = cfg.get("notifyOnBlock") ?? "both";
      if (mode === "notification" || mode === "both") {
        const msg = `👻 Ghosteado blocked: ${path.basename(p)}`;
        const choice = await vscode.window.showWarningMessage(msg, "Open Anyway", "View Log");
        if (choice === "Open Anyway") {
          guard.addBypass(p);
          for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
              if (
                tab.input instanceof vscode.TabInputText &&
                tab.input.uri.toString() === wUri.toString()
              ) {
                await vscode.window.tabGroups.close(tab);
              }
            }
          }
          await vscode.window.showTextDocument(doc.uri);
        } else if (choice === "View Log") {
          showStatusPanel(workspaceRoot);
        }
      }
    })
  );

  // ── React to block events (status bar) ────────────────────────────────────
  context.subscriptions.push(
    guard.onBlock(() => {
      blockCount++;
      updateStatusBar();
    })
  );

  // ── Commands ────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    // "Ghost This Folder" — launches the wizard (context menu or command palette)
    vscode.commands.registerCommand(
      "ghosteado.protectFolder",
      async (uri?: vscode.Uri) => {
        const result = await runSetupWizard(workspaceRoot, uri);
        if (!result) return;
        await executeWizardResult(result, workspaceRoot);
      }
    ),

    vscode.commands.registerCommand(
      "ghosteado.unprotectFolder",
      async (uri?: vscode.Uri) => {
        const target = uri ?? (await pickFolder("Remove Ghost"));
        if (target) await unghostFolder(target, workspaceRoot);
      }
    ),

    vscode.commands.registerCommand("ghosteado.setupWizard", async () => {
      const result = await runSetupWizard(workspaceRoot);
      if (!result) return;
      await executeWizardResult(result, workspaceRoot);
    }),

    vscode.commands.registerCommand("ghosteado.showStatus", () =>
      showStatusPanel(workspaceRoot)
    ),

    vscode.commands.registerCommand("ghosteado.clearLog", () => {
      clearLog(workspaceRoot);
      blockCount = 0;
      updateStatusBar();
      vscode.window.showInformationMessage("Ghosteado: Access log cleared.");
    }),

    vscode.commands.registerCommand(
      "ghosteado.regenerateSimulated",
      async (uri?: vscode.Uri) => {
        const target = uri ?? (await pickFolder("Regenerate Simulated Data For"));
        if (target) await generateSimulatedData(target.fsPath);
      }
    ),

    vscode.commands.registerCommand("ghosteado.addContainerProtection", async () => {
      await runContainerWizard(workspaceRoot);
    })
  );

  // ── Config watcher ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ghosteado")) {
        loadGhostedFolders();
        updateStatusBar();
      }
    })
  );
}

export function deactivate(): void {}

// ── Wizard execution ──────────────────────────────────────────────────────────

async function executeWizardResult(
  result: { sourceFolderPath: string; moveToPath: string | undefined; languages: ScriptLanguage[]; rowCount: number },
  workspaceRoot: string
): Promise<void> {
  const { sourceFolderPath, moveToPath, languages, rowCount } = result;

  // Move data outside workspace if requested
  if (moveToPath) {
    try {
      fs.cpSync(sourceFolderPath, moveToPath, { recursive: true });
      saveMoveRecord(workspaceRoot, sourceFolderPath, moveToPath);
      vscode.window.showInformationMessage(
        `👻 Data copied to ${moveToPath}. Original files at ${sourceFolderPath} were NOT deleted — remove them manually once you have verified the copy.`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Ghosteado: Failed to copy data — ${String(err)}`);
      return;
    }
  }

  // Ghost the source folder in workspace
  await ghostFolderDirect(vscode.Uri.file(sourceFolderPath), workspaceRoot, languages, rowCount);

  // Offer container protection as a final step
  await runContainerStep(workspaceRoot, languages, sourceFolderPath);
}

// ── Ghost (direct, used by wizard) ───────────────────────────────────────────

async function ghostFolderDirect(
  uri: vscode.Uri,
  workspaceRoot: string,
  languages: ScriptLanguage[],
  rowCount: number
): Promise<void> {
  const folderPath = uri.fsPath;

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    vscode.window.showErrorMessage("Ghosteado: Not a valid folder.");
    return;
  }

  const config = vscode.workspace.getConfiguration("ghosteado");
  const current: string[] = config.get("protectedFolders") ?? [];

  if (current.includes(folderPath)) {
    vscode.window.showInformationMessage(
      `Ghosteado: "${path.basename(folderPath)}" is already ghosted.`
    );
    return;
  }

  const updated = [...current, folderPath];
  await config.update("protectedFolders", updated, vscode.ConfigurationTarget.Workspace);
  guard.setGhostedFolders(updated);

  writeIgnoreFiles(folderPath, workspaceRoot);
  await addSearchExclusion(folderPath, workspaceRoot);
  await generateSimulatedData(folderPath, languages, rowCount);

  updateStatusBar();

  if (languages.length > 0) {
    // Read back the first generated prompt file and offer to copy to clipboard
    const promptFiles = fs.existsSync(path.join(folderPath, "_simulated"))
      ? fs.readdirSync(path.join(folderPath, "_simulated")).filter(f => f.startsWith("SIMULATE_WITH_AI"))
      : [];
    const firstPrompt = promptFiles[0]
      ? fs.readFileSync(path.join(folderPath, "_simulated", promptFiles[0]), "utf8")
      : "";

    const choice = await vscode.window.showInformationMessage(
      `👻 "${path.basename(folderPath)}" ghosted. AI prompt ready in _simulated/ — paste it into Copilot Chat, Cursor, or Claude to generate your simulation script.`,
      "Copy Prompt",
      "View Log"
    );
    if (choice === "Copy Prompt" && firstPrompt) {
      await vscode.env.clipboard.writeText(firstPrompt);
      vscode.window.showInformationMessage("👻 Prompt copied to clipboard! Paste it into your AI agent.");
    } else if (choice === "View Log") {
      showStatusPanel(workspaceRoot);
    }
  } else {
    vscode.window
      .showInformationMessage(
        `👻 "${path.basename(folderPath)}" ghosted. Placeholder data written to _simulated/.`,
        "View Log"
      )
      .then((c) => { if (c === "View Log") showStatusPanel(workspaceRoot); });
  }
}

// ── Unghost ───────────────────────────────────────────────────────────────────

async function unghostFolder(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
  const folderPath = uri.fsPath;
  const folderName = path.basename(folderPath);

  // Check if data was moved outside workspace and can be moved back
  const moveRecord = loadMoveRecord(workspaceRoot, folderPath);
  let moveBackMessage = "";
  if (moveRecord) {
    moveBackMessage = `\n\nData was previously moved to:\n${moveRecord}\n\nIt will be moved back to the workspace.`;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove Ghosteado protection from "${folderName}"?${moveBackMessage}`,
    { modal: true },
    "Remove Ghost"
  );
  if (confirm !== "Remove Ghost") return;

  // Move data back if it was moved outside workspace
  if (moveRecord) {
    try {
      fs.cpSync(moveRecord, folderPath, { recursive: true });
      fs.rmSync(moveRecord, { recursive: true, force: true });
      deleteMoveRecord(workspaceRoot, folderPath);
      vscode.window.showInformationMessage(
        `👻 Data moved back from ${moveRecord} to ${folderPath}.`
      );
    } catch (err) {
      const skip = await vscode.window.showWarningMessage(
        `Failed to move data back: ${String(err)}\n\nContinue removing ghost anyway?`,
        { modal: true },
        "Continue"
      );
      if (skip !== "Continue") return;
    }
  }

  const config = vscode.workspace.getConfiguration("ghosteado");
  const current: string[] = config.get("protectedFolders") ?? [];
  const updated = current.filter((p) => p !== folderPath);

  await config.update("protectedFolders", updated, vscode.ConfigurationTarget.Workspace);
  guard.setGhostedFolders(updated);
  removeIgnoreFiles(folderPath, workspaceRoot);
  await removeSearchExclusion(folderPath, workspaceRoot);

  updateStatusBar();
  vscode.window.showInformationMessage(
    `🔓 Ghosteado: Ghost removed from "${folderName}".`
  );
}

// ── Move records ──────────────────────────────────────────────────────────────

const MOVES_FILE = "moves.json";

function movesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".ghosteado", MOVES_FILE);
}

function saveMoveRecord(workspaceRoot: string, originalPath: string, movedToPath: string): void {
  try {
    ensureLogDir(workspaceRoot);
    const mp = movesPath(workspaceRoot);
    const records: Record<string, string> = fs.existsSync(mp)
      ? JSON.parse(fs.readFileSync(mp, "utf8"))
      : {};
    records[originalPath] = movedToPath;
    fs.writeFileSync(mp, JSON.stringify(records, null, 2), "utf8");
  } catch { /* ignore */ }
}

function loadMoveRecord(workspaceRoot: string, originalPath: string): string | undefined {
  try {
    const mp = movesPath(workspaceRoot);
    if (!fs.existsSync(mp)) return undefined;
    const records: Record<string, string> = JSON.parse(fs.readFileSync(mp, "utf8"));
    return records[originalPath];
  } catch {
    return undefined;
  }
}

function deleteMoveRecord(workspaceRoot: string, originalPath: string): void {
  try {
    const mp = movesPath(workspaceRoot);
    if (!fs.existsSync(mp)) return;
    const records: Record<string, string> = JSON.parse(fs.readFileSync(mp, "utf8"));
    delete records[originalPath];
    fs.writeFileSync(mp, JSON.stringify(records, null, 2), "utf8");
  } catch { /* ignore */ }
}

// ── search.exclude helpers ────────────────────────────────────────────────────

async function addSearchExclusion(folderPath: string, workspaceRoot: string): Promise<void> {
  const rel = path.relative(workspaceRoot, folderPath);
  const wsConfig = vscode.workspace.getConfiguration();
  const searchExclude: Record<string, boolean> = {
    ...(wsConfig.get<Record<string, boolean>>("search.exclude") ?? {}),
  };
  searchExclude[`${rel}/**`] = true;
  await wsConfig.update("search.exclude", searchExclude, vscode.ConfigurationTarget.Workspace);
}

async function removeSearchExclusion(folderPath: string, workspaceRoot: string): Promise<void> {
  const rel = path.relative(workspaceRoot, folderPath);
  const wsConfig = vscode.workspace.getConfiguration();
  const searchExclude: Record<string, boolean> = {
    ...(wsConfig.get<Record<string, boolean>>("search.exclude") ?? {}),
  };
  delete searchExclude[`${rel}/**`];
  await wsConfig.update("search.exclude", searchExclude, vscode.ConfigurationTarget.Workspace);
}

// ── Simulated data generation ─────────────────────────────────────────────────

async function generateSimulatedData(
  folderPath: string,
  languages: ScriptLanguage[] = [],
  rowCount?: number
): Promise<void> {
  const cfg  = vscode.workspace.getConfiguration("ghosteado");
  const rows = rowCount ?? (cfg.get<number>("simulatedRowCount") ?? 20);
  const seed = cfg.get<number>("simulatedSeed") ?? 42;

  const simDir = path.join(folderPath, "_simulated");
  if (!fs.existsSync(simDir)) fs.mkdirSync(simDir, { recursive: true });

  // README
  fs.writeFileSync(
    path.join(simDir, "README.md"),
    [
      "# Simulated Data — Ghosteado",
      "",
      "⚠️ This folder contains **synthetic data only**.",
      "It was auto-generated by Ghosteado from the real CSV headers.",
      languages.length > 0
        ? [
            "",
            "To get a more realistic simulation script, open the `SIMULATE_WITH_AI_*.md`",
            "file(s) in this folder and paste the prompt into your AI agent",
            "(Copilot Chat, Cursor, Claude, etc.). The AI will write a tailored",
            "R or Python script that produces better synthetic data.",
          ].join("\n")
        : `\nAll values are fake and deterministic (seed: ${seed}).`,
      "",
      "Use this folder to get coding assistance without exposing real data.",
      "Your analysis scripts should still point to the real data path above.",
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(path.join(simDir, ".ghosteado-sim"), "", "utf8");

  // Scan for CSVs and generate placeholder + scripts
  let csvCount = 0;
  try {
    const entries = fs.readdirSync(folderPath);
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".csv")) continue;
      const csvPath = path.join(folderPath, entry);
      try {
        const firstLine = readFirstLine(csvPath);
        if (!firstLine) continue;
        const headers = firstLine.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
        if (headers.length === 0) continue;

        // Schema file
        const schemaLines = headers.map((h) => `${h}: ${inferColType(h)}`);
        fs.writeFileSync(
          path.join(simDir, entry.replace(".csv", ".schema.txt")),
          "# Ghosteado — inferred column types\n" + schemaLines.join("\n") + "\n",
          "utf8"
        );

        // Placeholder CSV (immediate, no dependencies)
        fs.writeFileSync(path.join(simDir, entry), simulateCsv(headers, rows, seed), "utf8");

        // AI pre-prompt
        if (languages.length > 0) {
          const lang = languages.length === 2 ? "both" : languages[0];
          const baseName = entry.replace(/\.csv$/i, "");
          fs.writeFileSync(
            path.join(simDir, `SIMULATE_WITH_AI_${baseName}.md`),
            generateAIPrompt(entry, headers, rows, lang),
            "utf8"
          );
        }

        csvCount++;
      } catch {
        // Skip unreadable CSVs silently
      }
    }
  } catch {
    // Folder not readable
  }

  if (csvCount === 0) {
    const defaultHeaders = ["id", "age", "sex", "year", "icd_code", "count", "rate"];
    fs.writeFileSync(
      path.join(simDir, "example_simulated.csv"),
      simulateCsv(defaultHeaders, rows, seed),
      "utf8"
    );
    if (languages.length > 0) {
      const lang = languages.length === 2 ? "both" : languages[0];
      fs.writeFileSync(
        path.join(simDir, "SIMULATE_WITH_AI_example.md"),
        generateAIPrompt("example_simulated.csv", defaultHeaders, rows, lang),
        "utf8"
      );
    }
  }
}

function readFirstLine(filePath: string): string | null {
  try {
    const buf      = Buffer.alloc(4096);
    const fd       = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const nl   = text.indexOf("\n");
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return null;
  }
}

// ── Ignore files ──────────────────────────────────────────────────────────────

const IGNORE_FILENAMES = [
  ".copilotignore",
  ".cursorignore",
  ".continueignore",
  ".codeiumignore",
  ".tabnignore",
  ".aiignore",
];

const GHOST_TAG = "# [Ghosteado-managed]";

function writeIgnoreFiles(folderPath: string, workspaceRoot: string): void {
  const content = `${GHOST_TAG}\n*\n**/*\n`;

  for (const fn of IGNORE_FILENAMES) {
    const fp = path.join(folderPath, fn);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, content, "utf8");
  }

  const rel   = path.relative(workspaceRoot, folderPath);
  const block = `\n${GHOST_TAG}\n${rel}/\n${rel}/**\n`;
  for (const fn of [...IGNORE_FILENAMES, ".gitignore"]) {
    const rp = path.join(workspaceRoot, fn);
    if (fs.existsSync(rp)) {
      const existing = fs.readFileSync(rp, "utf8");
      if (!existing.includes(rel + "/")) fs.appendFileSync(rp, block, "utf8");
    } else if (fn !== ".gitignore") {
      fs.writeFileSync(rp, block, "utf8");
    }
  }
}

function removeIgnoreFiles(folderPath: string, workspaceRoot: string): void {
  for (const fn of IGNORE_FILENAMES) {
    const fp = path.join(folderPath, fn);
    if (fs.existsSync(fp)) {
      const c = fs.readFileSync(fp, "utf8");
      if (c.includes("Ghosteado")) fs.unlinkSync(fp);
    }
  }

  const rel    = path.relative(workspaceRoot, folderPath);
  const escRel = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(
    `\\n?${GHOST_TAG}\\n${escRel}\\/\\n${escRel}\\/\\*\\*\\n?`,
    "g"
  );
  for (const fn of [...IGNORE_FILENAMES, ".gitignore"]) {
    const rp = path.join(workspaceRoot, fn);
    if (!fs.existsSync(rp)) continue;
    const before = fs.readFileSync(rp, "utf8");
    const after  = before.replace(blockRe, "\n");
    if (after !== before) fs.writeFileSync(rp, after, "utf8");
  }
}

// ── Status bar ────────────────────────────────────────────────────────────────

function updateStatusBar(): void {
  const cfg     = vscode.workspace.getConfiguration("ghosteado");
  const folders: string[] = cfg.get("protectedFolders") ?? [];
  const n       = folders.length;

  if (n === 0) {
    statusBarItem.text            = "$(ghost) Ghosteado";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.tooltip         = "Ghosteado — no folders ghosted\nClick to manage";
  } else if (blockCount === 0) {
    statusBarItem.text            = `$(ghost) ${n} ghosted`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusBarItem.tooltip         = `Ghosteado — ${n} folder(s) ghosted\nNo blocked attempts yet\nClick to view log`;
  } else {
    statusBarItem.text            = `$(ghost) ${n} ghosted  $(warning) ${blockCount} blocked`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    statusBarItem.tooltip         = `Ghosteado — ${blockCount} blocked access attempt(s)\nClick to view log`;
  }

  statusBarItem.show();
}

// ── Status panel ──────────────────────────────────────────────────────────────

function showStatusPanel(workspaceRoot: string): void {
  const cfg     = vscode.workspace.getConfiguration("ghosteado");
  const folders: string[] = cfg.get("protectedFolders") ?? [];
  const events  = recentEvents(workspaceRoot, 20);

  const items: vscode.QuickPickItem[] = [];

  items.push({ label: "─── Ghosted Folders ───", kind: vscode.QuickPickItemKind.Separator });
  if (folders.length === 0) {
    items.push({ label: "$(circle-slash) None", description: "No folders ghosted yet" });
  } else {
    for (const f of folders) {
      const moved = loadMoveRecord(workspaceRoot, f);
      items.push({
        label:       `$(ghost) ${path.basename(f)}`,
        description: moved ? `→ ${moved}` : f,
        detail:      moved ? `Data stored at: ${moved}` : undefined,
      });
    }
  }

  items.push({ label: "─── Recent Blocked Attempts ───", kind: vscode.QuickPickItemKind.Separator });
  if (events.length === 0) {
    items.push({ label: "$(check) No blocked attempts recorded", description: "" });
  } else {
    for (const ev of events) {
      const time = new Date(ev.timestamp).toLocaleTimeString();
      items.push({
        label:       `$(warning) ${path.basename(ev.filePath)}`,
        description: `${ev.operation}  •  ${time}`,
        detail:      ev.filePath,
      });
    }
  }

  items.push({ label: "─── Actions ───", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(trash) Clear access log", description: "" });
  items.push({ label: "$(close) Close", description: "" });

  vscode.window
    .showQuickPick(items, {
      title:              "Ghosteado — Status & Access Log",
      placeHolder:        "Recent blocked access attempts and ghosted folders",
      matchOnDescription: true,
    })
    .then((sel) => {
      if (!sel) return;
      if (sel.label.includes("Clear access log")) {
        vscode.commands.executeCommand("ghosteado.clearLog");
      }
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadGhostedFolders(): void {
  const cfg    = vscode.workspace.getConfiguration("ghosteado");
  const raw    = cfg.get<string[]>("protectedFolders") ?? [];
  const folders = raw.filter((p: string) => fs.existsSync(p));
  guard.setGhostedFolders(folders);
}

async function pickFolder(label: string): Promise<vscode.Uri | undefined> {
  const result = await vscode.window.showOpenDialog({
    canSelectFiles:   false,
    canSelectFolders: true,
    canSelectMany:    false,
    openLabel:        label,
  });
  return result?.[0];
}
