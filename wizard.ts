/**
 * wizard.ts — Ghosteado Data Protection Setup Wizard
 *
 * A 4-step native VS Code dialog flow that guides the user through:
 *   1. Pick the sensitive data folder
 *   2. Choose to move it outside the workspace (optional)
 *   3. Select analysis language for simulation scripts (R / Python / both)
 *   4. Set row count, confirm, and execute
 *
 * After the wizard completes, extension.ts calls runContainerStep() from
 * devcontainer.ts to optionally add Docker container isolation (step 5).
 */

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

export type ScriptLanguage = "r" | "python";

export interface WizardResult {
  sourceFolderPath: string;
  /** Destination path outside workspace. undefined = keep in place. */
  moveToPath: string | undefined;
  languages: ScriptLanguage[];
  rowCount: number;
}

/**
 * @param preSelected  URI already known (e.g. from Explorer right-click).
 *                     If provided, step 1 (folder picker) is skipped.
 */
export async function runSetupWizard(
  workspaceRoot: string,
  preSelected?: vscode.Uri
): Promise<WizardResult | undefined> {
  // ── Step 1: Pick sensitive folder (skipped when called from context menu) ──

  let sourceFolderPath: string;
  if (preSelected) {
    sourceFolderPath = preSelected.fsPath;
  } else {
    const step1 = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select This Folder",
      title: "Ghosteado (1/4) — Which folder contains your sensitive data?",
      defaultUri: vscode.Uri.file(workspaceRoot),
    });
    if (!step1?.[0]) return undefined;
    sourceFolderPath = step1[0].fsPath;
  }
  const folderName = path.basename(sourceFolderPath);

  // ── Step 2: Move outside workspace? ───────────────────────────────────────

  const step2 = await vscode.window.showQuickPick(
    [
      {
        label: "$(folder-moved) Move outside workspace",
        description: "Recommended — data lives outside VS Code's reach entirely",
        detail: `Will copy "${folderName}" to a location you choose, outside the project folder.`,
        value: "move",
      },
      {
        label: "$(shield) Keep in place and ghost it",
        description: "Data stays here but AI agents are blocked from reading it",
        detail: "Simpler setup. Good if you can't move the data.",
        value: "keep",
      },
    ],
    {
      title: "Ghosteado (2/4) — Where should the data live?",
      placeHolder: "Choose a data location strategy",
      ignoreFocusOut: true,
    }
  );
  if (!step2) return undefined;

  let moveToPath: string | undefined;

  if (step2.value === "move") {
    const projectName = path.basename(workspaceRoot);
    const defaultDestParent = path.join(os.homedir(), "Protected-Research-Data", projectName);
    vscode.window.showInformationMessage(
      `Suggested destination: ${defaultDestParent} — pick or create a folder below.`
    );
    const destResult = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Move Data Here",
      title: `Ghosteado (2/4) — Pick destination folder (suggested: ~/Protected-Research-Data/${projectName})`,
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "Protected-Research-Data")),
    });
    if (!destResult?.[0]) return undefined;
    moveToPath = path.join(destResult[0].fsPath, folderName);
  }

  // ── Step 3: Script language ────────────────────────────────────────────────

  const step3 = await vscode.window.showQuickPick(
    [
      {
        label: "$(file-code) R",
        description: "Creates a prompt that tells your AI to write an R simulation script",
        detail: "Paste it into Copilot Chat, Cursor, or Claude — the AI writes the script for you",
        value: "r",
      },
      {
        label: "$(file-code) Python",
        description: "Creates a prompt that tells your AI to write a Python simulation script",
        detail: "Paste it into Copilot Chat, Cursor, or Claude — the AI writes the script for you",
        value: "python",
      },
      {
        label: "$(files) Both R and Python",
        description: "Creates a prompt asking for both languages",
        value: "both",
      },
      {
        label: "$(circle-slash) Skip — use placeholder CSV only",
        description: "Ghosteado writes a basic placeholder CSV immediately, no AI prompt",
        value: "none",
      },
    ],
    {
      title: "Ghosteado (3/4) — Simulation script language",
      placeHolder: "Which language do you use for data analysis?",
      ignoreFocusOut: true,
    }
  );
  if (!step3) return undefined;

  const languages: ScriptLanguage[] =
    step3.value === "both"
      ? ["r", "python"]
      : step3.value === "none"
      ? []
      : [step3.value as ScriptLanguage];

  // ── Step 4: Row count + confirm ────────────────────────────────────────────

  const step4 = await vscode.window.showInputBox({
    title: "Ghosteado (4/4) — Simulated dataset size",
    prompt: "How many rows should the simulated dataset have?",
    value: "100",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 100_000) return "Enter a number between 1 and 100,000";
      return undefined;
    },
  });
  if (step4 === undefined) return undefined;
  const rowCount = parseInt(step4, 10);

  // ── Confirm summary ────────────────────────────────────────────────────────

  const summaryLines = [
    moveToPath
      ? `• Copy "${folderName}" → ${moveToPath}`
      : `• Ghost "${folderName}" in place`,
    `• Write AI ignore files (.copilotignore, .cursorignore, etc.)`,
    `• Exclude from workspace search (search.exclude)`,
    languages.includes("r")
      ? `• Generate _simulated/generate_simulated.R (${rowCount} rows)`
      : "",
    languages.includes("python")
      ? `• Generate _simulated/generate_simulated.py (${rowCount} rows)`
      : "",
    `• Generate placeholder CSV immediately in _simulated/`,
    moveToPath
      ? `\nNote: original files are NOT deleted automatically — you can remove them manually after verifying the copy.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const confirm = await vscode.window.showWarningMessage(
    `Ghosteado will do the following:\n\n${summaryLines}`,
    { modal: true },
    "Proceed"
  );
  if (confirm !== "Proceed") return undefined;

  return { sourceFolderPath, moveToPath, languages, rowCount };
}
