/**
 * wizard.ts
 * Container-first Ghosteado data protection wizard.
 *
 * The wizard now focuses on:
 *   1. Selecting the dataset folder inside the workspace
 *   2. Moving that dataset outside the workspace
 *   3. Leaving a stable host path behind via a link at the original location
 *   4. Capturing schema for prompt generation
 *   5. Optionally preparing a synthetic workspace for in-container execution
 */

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import type { PromptLanguage } from "./simulator";

export interface ProtectionWizardResult {
  sourceFolderPath: string;
  realDatasetPath: string;
  promptLanguage: PromptLanguage;
  prepareSyntheticWorkspace: boolean;
}

export async function runSetupWizard(
  workspaceRoot: string,
  preSelected?: vscode.Uri
): Promise<ProtectionWizardResult | undefined> {
  let sourceFolderPath: string;

  if (preSelected) {
    sourceFolderPath = preSelected.fsPath;
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Protect This Folder",
      title: "Ghosteado (1/4) - Select the dataset folder to protect",
      defaultUri: vscode.Uri.file(workspaceRoot),
    });
    if (!picked?.[0]) return undefined;
    sourceFolderPath = picked[0].fsPath;
  }

  const projectName = path.basename(workspaceRoot);
  const workspaceFolderRel = path.relative(workspaceRoot, sourceFolderPath);

  if (
    workspaceFolderRel === "" ||
    workspaceFolderRel.startsWith("..") ||
    path.isAbsolute(workspaceFolderRel)
  ) {
    void vscode.window.showErrorMessage(
      "Ghosteado: Select a dataset folder inside the current workspace, not the workspace root."
    );
    return undefined;
  }

  const destinationPick = await vscode.window.showQuickPick(
    [
      {
        label: "Protected research data root (Recommended)",
        description: `Use ~/Protected-Research-Data/${projectName}`,
        value: "default",
      },
      {
        label: "Choose another host location",
        description: "Pick a different folder outside the workspace",
        value: "custom",
      },
    ],
    {
      title: "Ghosteado (2/4) - Where should the real dataset live?",
      placeHolder: "The real dataset will be moved outside the workspace and linked back at its current path on the host",
      ignoreFocusOut: true,
    }
  );
  if (!destinationPick) return undefined;

  const defaultParent = path.join(os.homedir(), "Protected-Research-Data", projectName);
  let destinationParent = defaultParent;

  if (destinationPick.value === "custom") {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Store Data Here",
      title: "Ghosteado (2/4) - Pick a host folder for the real dataset",
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "Protected-Research-Data")),
    });
    if (!selected?.[0]) return undefined;
    destinationParent = selected[0].fsPath;
  }

  const languagePick = await vscode.window.showQuickPick(
    [
      {
        label: "R (Recommended)",
        description: "Use R-focused prompt instructions for schema-aware code generation",
        value: "r",
      },
      {
        label: "Python",
        description: "Use Python-focused prompt instructions",
        value: "python",
      },
      {
        label: "Both R and Python",
        description: "Generate prompts that work for both analysis stacks",
        value: "both",
      },
      {
        label: "No language preference",
        description: "Keep the prompt language-neutral",
        value: "none",
      },
    ],
    {
      title: "Ghosteado (3/4) - Prompt language",
      placeHolder: "Choose the default language for schema and synthetic data prompts",
      ignoreFocusOut: true,
    }
  );
  if (!languagePick) return undefined;

  const syntheticPick = await vscode.window.showQuickPick(
    [
      {
        label: "Prepare a synthetic workspace (Recommended)",
        description: "Create src/_simulated and a prompt scaffold for optional in-container synthetic data",
        value: "prepare",
      },
      {
        label: "Skip synthetic setup for now",
        description: "Container can still generate code from schema, but not run end-to-end data reads yet",
        value: "skip",
      },
    ],
    {
      title: "Ghosteado (4/4) - Synthetic workspace",
      placeHolder: "Choose whether Ghosteado should prepare a synthetic data location now",
      ignoreFocusOut: true,
    }
  );
  if (!syntheticPick) return undefined;

  const realDatasetPath = path.join(destinationParent, workspaceFolderRel);
  const prepareSyntheticWorkspace = syntheticPick.value === "prepare";
  const promptLanguage = languagePick.value as PromptLanguage;

  const summaryLines = [
    `- Move the real dataset to: ${realDatasetPath}`,
    `- Preserve the workspace-relative folder structure outside the workspace`,
    `- Replace the workspace folder with a host link at the same path`,
    `- Keep analysis paths stable for host tools and container overlays`,
    `- Capture a local-only schema summary for prompts`,
    `- Create src/ if it does not exist`,
    prepareSyntheticWorkspace
      ? `- Prepare synthetic workspace under src/_simulated/${workspaceFolderRel}`
      : "- Do not prepare synthetic files yet",
    `- Rebuild container protection so AI work happens in the isolated runtime`,
    "",
    "Protection note:",
    "The host link keeps paths stable for RStudio or Jupyter outside the container. Use AI tools inside the container, not on the host, if you want the isolation boundary to hold.",
    !prepareSyntheticWorkspace
      ? "If no synthetic data exists, the container can still generate code from schema, but it cannot run end-to-end data reads. That is fine if the goal is code generation first. If you want runnable code in-container, synthetic data needs to exist and be mounted there."
      : "Synthetic workspace preparation does not create fake data automatically. You will still generate or add synthetic data explicitly later.",
  ];

  const confirm = await vscode.window.showWarningMessage(
    `Ghosteado will do the following:\n\n${summaryLines.filter(Boolean).join("\n")}`,
    { modal: true },
    "Protect Dataset"
  );
  if (confirm !== "Protect Dataset") return undefined;

  return {
    sourceFolderPath,
    realDatasetPath,
    promptLanguage,
    prepareSyntheticWorkspace,
  };
}
