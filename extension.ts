/**
 * extension.ts
 * Ghosteado main entry point.
 *
 * Ghosteado now treats container isolation as the primary protection model:
 *   - The real dataset is moved outside the workspace
 *   - The original workspace path becomes a host link for local tools
 *   - The container can overlay src/_simulated onto that same path
 *   - Schema and prompt generation happen from safe metadata, not placeholders
 *
 * The editor interception flow is still available as a host-side warning, but it
 * is no longer the primary protection boundary.
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
import {
  collectDatasetSchema,
  formatSchemaMarkdown,
  generateSimulationPrompt,
  type DatasetSchemaSummary,
  type PromptLanguage,
} from "./simulator";
import { runSetupWizard } from "./wizard";
import {
  buildMountsFromProtectedDatasets,
  captureEnvironmentPackages,
  checkPrerequisites,
  clearContainerFiles,
  type ContainerMount,
  isInsideContainer,
  reopenInContainer,
  resolveContainerWorkspaceRoot,
  writeContainerFiles,
} from "./devcontainer";

interface ProtectedDatasetManifest {
  id: string;
  name: string;
  workspaceFolderRel: string;
  syntheticFolderRel: string;
  schemaFileRel: string;
  promptLanguage: PromptLanguage;
  createdAt: string;
}

interface ProtectedWorkspaceManifest {
  version: 1;
  createdAt: string;
  codeRootRel: string;
  protectedDatasets: ProtectedDatasetManifest[];
}

type StatusAction =
  | "openDatasetSchema"
  | "openWarning"
  | "viewSchema"
  | "copyPrompt"
  | "prepareSyntheticPrompt"
  | "refreshContainer"
  | "resumeContainer"
  | "clearLog";

interface StatusQuickPickItem extends vscode.QuickPickItem {
  action?: StatusAction;
  dataset?: ProtectedDatasetManifest;
  warningPath?: string;
}

type RealPathMap = Record<string, Record<string, string>>;

const MANIFEST_VERSION = 1;
const MANIFEST_DIR = ".ghosteado";
const MANIFEST_FILE = "project.json";
const REAL_PATHS_KEY = "ghosteado.realDatasetPaths";

let extensionContext: vscode.ExtensionContext;
let guard: GhostGuard;
let statusBarItem: vscode.StatusBarItem;
let blockCount = 0;
let resumePromptShown = false;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    registerNoWorkspaceCommands(context);
    return;
  }

  ensureLogDir(workspaceRoot);

  guard = new GhostGuard(workspaceRoot);
  loadProtectedFolders();
  context.subscriptions.push({ dispose: () => guard.dispose() });

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GHOSTEADO_SCHEME,
      new GhostContentProvider()
    )
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    200
  );
  statusBarItem.command = "ghosteado.showStatus";
  context.subscriptions.push(statusBarItem);
  updateStatusBar(workspaceRoot);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (doc) => {
      if (doc.uri.scheme !== "file") return;
      const filePath = doc.uri.fsPath;
      if (!guard.isGhosted(filePath) || guard.isInBypass(filePath)) return;

      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.fsPath === filePath
          ) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }

      const placeholderUri = warningUri(filePath);
      const placeholderDoc = await vscode.workspace.openTextDocument(placeholderUri);
      await vscode.window.showTextDocument(placeholderDoc, {
        preview: true,
        preserveFocus: false,
      });

      guard.logBlock(filePath, "open");

      const cfg = vscode.workspace.getConfiguration("ghosteado");
      const mode = cfg.get<string>("notifyOnBlock") ?? "both";
      if (mode === "notification" || mode === "both") {
        const choice = await vscode.window.showWarningMessage(
          `👻 Ghosteado warning: ${path.basename(filePath)} was opened on the host.`,
          "Open Anyway",
          "Resume in Container"
        );

        if (choice === "Open Anyway") {
          guard.addBypass(filePath);
          await closeWarningTabs(placeholderUri);
          await vscode.window.showTextDocument(doc.uri);
        } else if (choice === "Resume in Container") {
          await vscode.commands.executeCommand("ghosteado.resumeProtectedWorkspace");
        }
      }
    })
  );

  context.subscriptions.push(
    guard.onBlock(() => {
      blockCount += 1;
      updateStatusBar(workspaceRoot);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ghosteado.protectFolder",
      async (uri?: vscode.Uri) => {
        const result = await runSetupWizard(workspaceRoot, uri);
        if (!result) return;
        await executeProtectionWizard(workspaceRoot, result);
      }
    ),

    vscode.commands.registerCommand("ghosteado.setupWizard", async () => {
      const result = await runSetupWizard(workspaceRoot);
      if (!result) return;
      await executeProtectionWizard(workspaceRoot, result);
    }),

    vscode.commands.registerCommand(
      "ghosteado.unprotectFolder",
      async (uri?: vscode.Uri) => {
        await unprotectDataset(workspaceRoot, uri);
      }
    ),

    vscode.commands.registerCommand("ghosteado.viewSchema", async () => {
      await viewSchema(workspaceRoot);
    }),

    vscode.commands.registerCommand("ghosteado.copySimulationPrompt", async () => {
      await copySimulationPrompt(workspaceRoot, false);
    }),

    vscode.commands.registerCommand(
      "ghosteado.regenerateSimulated",
      async () => {
        await copySimulationPrompt(workspaceRoot, true);
      }
    ),

    vscode.commands.registerCommand(
      "ghosteado.addContainerProtection",
      async () => {
        await refreshContainerProtection(workspaceRoot, true);
      }
    ),

    vscode.commands.registerCommand(
      "ghosteado.resumeProtectedWorkspace",
      async () => {
        await resumeProtectedWorkspace(workspaceRoot);
      }
    ),

    vscode.commands.registerCommand("ghosteado.showStatus", () => {
      showStatusPanel(workspaceRoot);
    }),

    vscode.commands.registerCommand("ghosteado.clearLog", () => {
      clearLog(workspaceRoot);
      blockCount = 0;
      updateStatusBar(workspaceRoot);
      void vscode.window.showInformationMessage("Ghosteado: Access log cleared.");
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("ghosteado")) {
        loadProtectedFolders();
        updateStatusBar(workspaceRoot);
      }
    })
  );

  void maybePromptToResume(workspaceRoot);
}

export function deactivate(): void {}

function registerNoWorkspaceCommands(context: vscode.ExtensionContext): void {
  const noWorkspace = () =>
    vscode.window.showWarningMessage("Ghosteado: Open a workspace folder first.");

  context.subscriptions.push(
    vscode.commands.registerCommand("ghosteado.protectFolder", noWorkspace),
    vscode.commands.registerCommand("ghosteado.setupWizard", noWorkspace),
    vscode.commands.registerCommand("ghosteado.unprotectFolder", noWorkspace),
    vscode.commands.registerCommand("ghosteado.viewSchema", noWorkspace),
    vscode.commands.registerCommand("ghosteado.copySimulationPrompt", noWorkspace),
    vscode.commands.registerCommand("ghosteado.regenerateSimulated", noWorkspace),
    vscode.commands.registerCommand("ghosteado.addContainerProtection", noWorkspace),
    vscode.commands.registerCommand("ghosteado.resumeProtectedWorkspace", noWorkspace),
    vscode.commands.registerCommand("ghosteado.showStatus", noWorkspace),
    vscode.commands.registerCommand("ghosteado.clearLog", noWorkspace)
  );
}

async function executeProtectionWizard(
  workspaceRoot: string,
  result: {
    sourceFolderPath: string;
    realDatasetPath: string;
    promptLanguage: PromptLanguage;
    prepareSyntheticWorkspace: boolean;
  }
): Promise<void> {
  const sourceFolderPath = path.resolve(result.sourceFolderPath);
  const workspaceFolderRel = toPosix(path.relative(workspaceRoot, sourceFolderPath));

  if (
    workspaceFolderRel === "" ||
    workspaceFolderRel.startsWith("..") ||
    path.isAbsolute(workspaceFolderRel)
  ) {
    void vscode.window.showErrorMessage(
      "Ghosteado: Select a dataset folder inside the current workspace, not the workspace root."
    );
    return;
  }

  if (!fs.existsSync(sourceFolderPath) || !fs.statSync(sourceFolderPath).isDirectory()) {
    void vscode.window.showErrorMessage("Ghosteado: The selected dataset folder is not valid.");
    return;
  }

  if (path.resolve(result.realDatasetPath).startsWith(path.resolve(workspaceRoot) + path.sep)) {
    void vscode.window.showErrorMessage(
      "Ghosteado: The protected dataset must live outside the workspace."
    );
    return;
  }

  const manifest = loadManifest(workspaceRoot);
  if (manifest.protectedDatasets.some((dataset) => dataset.workspaceFolderRel === workspaceFolderRel)) {
    void vscode.window.showInformationMessage(
      `Ghosteado: "${workspaceFolderRel}" is already protected.`
    );
    return;
  }
  if (hasOverlappingProtectedDataset(workspaceRoot, sourceFolderPath, manifest.protectedDatasets)) {
    void vscode.window.showErrorMessage(
      "Ghosteado: Nested protected datasets are not supported. Select a top-level dataset folder that does not overlap an existing protected dataset."
    );
    return;
  }

  let dataset: ProtectedDatasetManifest | undefined;
  let syntheticReady = false;

  try {
    const protectionResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Ghosteado: Protecting "${path.basename(sourceFolderPath)}"...`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Collecting a safe schema summary..." });
        const schema = collectDatasetSchema(sourceFolderPath, workspaceFolderRel);
        ensureProjectDirectories(workspaceRoot);

        progress.report({ message: "Moving the real dataset outside the workspace..." });
        await protectDatasetOnHost(sourceFolderPath, result.realDatasetPath);

        progress.report({ message: "Saving the protected workspace metadata..." });
        const datasetId = makeDatasetId(workspaceFolderRel);
        const nextDataset: ProtectedDatasetManifest = {
          id: datasetId,
          name: path.basename(sourceFolderPath),
          workspaceFolderRel,
          syntheticFolderRel: toPosix(path.join("src", "_simulated", workspaceFolderRel)),
          schemaFileRel: toPosix(path.join(MANIFEST_DIR, `schema-${datasetId}.json`)),
          promptLanguage: result.promptLanguage,
          createdAt: new Date().toISOString(),
        };

        manifest.protectedDatasets.push(nextDataset);
        saveManifest(workspaceRoot, manifest);
        saveSchema(workspaceRoot, nextDataset, schema);
        await saveRealDatasetPath(workspaceRoot, nextDataset.id, path.resolve(result.realDatasetPath));

        if (result.prepareSyntheticWorkspace) {
          ensureSyntheticWorkspace(workspaceRoot, nextDataset);
        }

        await addProtectedFolder(sourceFolderPath);
        loadProtectedFolders();

        return {
          dataset: nextDataset,
          syntheticReady: hasPreparedSyntheticWorkspace(workspaceRoot, nextDataset),
        };
      }
    );

    dataset = protectionResult.dataset;
    syntheticReady = protectionResult.syntheticReady;
  } catch (error) {
    void vscode.window.showErrorMessage(
      `👻 Ghosteado: Failed to protect the dataset. ${String(error)}`
    );
    return;
  }

  if (!dataset) {
    void vscode.window.showErrorMessage("👻 Ghosteado: Failed to save the protected dataset.");
    return;
  }

  const containerReady = await refreshContainerProtection(workspaceRoot, false);
  const infoChoices = ["View Schema", "Copy Prompt"] as const;
  const finalChoices = containerReady
    ? [...infoChoices, "Reopen in Container"] as const
    : infoChoices;

  const picked = await vscode.window.showInformationMessage(
    syntheticReady
      ? `👻 Ghosteado protected "${dataset.name}". The host path still works outside the container, and src/_simulated is prepared for this dataset. Add synthetic files there when you want the container path to become runnable.`
      : `👻 Ghosteado protected "${dataset.name}". If no synthetic data exists, the container can still generate code from schema, but it cannot run end-to-end data reads. That is fine if the goal is code generation first. If you want runnable code in-container, synthetic data needs to exist and be mounted there.`,
    ...finalChoices
  );

  if (picked === "View Schema") {
    await openSchemaDocument(workspaceRoot, dataset);
  } else if (picked === "Copy Prompt") {
    await copySimulationPrompt(workspaceRoot, false, dataset);
  } else if (picked === "Reopen in Container") {
    await reopenInContainer();
  }

  updateStatusBar(workspaceRoot);
}

async function unprotectDataset(
  workspaceRoot: string,
  uri?: vscode.Uri
): Promise<void> {
  const manifest = loadManifest(workspaceRoot);
  const dataset = await pickProtectedDataset(
    workspaceRoot,
    manifest,
    uri,
    "Remove protection from which dataset?"
  );
  if (!dataset) return;

  const workspaceFolderPath = path.join(workspaceRoot, dataset.workspaceFolderRel);
  const realDatasetPath =
    (await loadRealDatasetPath(workspaceRoot, dataset.id)) ??
    resolveLinkedDatasetPath(workspaceFolderPath);
  if (!realDatasetPath) {
    void vscode.window.showErrorMessage(
      `Ghosteado: Missing host path metadata for "${dataset.name}".`
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove Ghosteado protection from "${dataset.name}" and move the real dataset back into the workspace?`,
    { modal: true },
    "Remove Protection"
  );
  if (confirm !== "Remove Protection") return;

  try {
    if (fs.existsSync(workspaceFolderPath) && fs.lstatSync(workspaceFolderPath).isSymbolicLink()) {
      fs.unlinkSync(workspaceFolderPath);
    } else if (fs.existsSync(workspaceFolderPath)) {
      fs.rmSync(workspaceFolderPath, { recursive: true, force: true });
    }

    moveDirectory(realDatasetPath, workspaceFolderPath);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Ghosteado: Failed to restore the real dataset. ${String(error)}`
    );
    return;
  }

  manifest.protectedDatasets = manifest.protectedDatasets.filter(
    (item) => item.id !== dataset.id
  );
  saveManifest(workspaceRoot, manifest);
  await removeRealDatasetPath(workspaceRoot, dataset.id);
  await removeProtectedFolder(workspaceFolderPath);

  if (manifest.protectedDatasets.length > 0) {
    void refreshContainerProtection(workspaceRoot, false);
  } else if (fs.existsSync(path.join(workspaceRoot, ".devcontainer", "devcontainer.json"))) {
    clearContainerFiles(workspaceRoot);
  }

  loadProtectedFolders();
  updateStatusBar(workspaceRoot);
  void vscode.window.showInformationMessage(
    `👻 Ghosteado: Protection removed from "${dataset.name}".`
  );
}

async function viewSchema(workspaceRoot: string): Promise<void> {
  const manifest = loadManifest(workspaceRoot);
  const dataset = await pickProtectedDataset(
    workspaceRoot,
    manifest,
    undefined,
    "View schema for which dataset?"
  );
  if (!dataset) return;

  await openSchemaDocument(workspaceRoot, dataset);
}

async function openSchemaDocument(
  workspaceRoot: string,
  dataset: ProtectedDatasetManifest
): Promise<void> {
  const schema = loadSchema(workspaceRoot, dataset);
  if (!schema) {
    void vscode.window.showErrorMessage(
      `Ghosteado: No schema summary is available for "${dataset.name}".`
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: formatSchemaMarkdown(schema),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function copySimulationPrompt(
  workspaceRoot: string,
  writePromptFile: boolean,
  forcedDataset?: ProtectedDatasetManifest
): Promise<void> {
  const manifest = loadManifest(workspaceRoot);
  const dataset =
    forcedDataset ??
    (await pickProtectedDataset(
      workspaceRoot,
      manifest,
      undefined,
      writePromptFile
        ? "Prepare synthetic data for which dataset?"
        : "Copy a simulation prompt for which dataset?"
    ));
  if (!dataset) return;

  const schema = loadSchema(workspaceRoot, dataset);
  if (!schema) {
    void vscode.window.showErrorMessage(
      `Ghosteado: No schema summary is available for "${dataset.name}".`
    );
    return;
  }

  const rows = await promptForSyntheticRowCount();
  if (rows === undefined) return;

  const prompt = generateSimulationPrompt(schema, {
    language: dataset.promptLanguage,
    rows,
    analysisPath: buildAnalysisPath(workspaceRoot, dataset.workspaceFolderRel),
    syntheticFolderRel: dataset.syntheticFolderRel,
  });

  if (writePromptFile) {
    ensureSyntheticWorkspace(workspaceRoot, dataset);
    const promptFile = promptFilePath(workspaceRoot, dataset);
    fs.writeFileSync(promptFile, prompt, "utf8");

    const doc = await vscode.workspace.openTextDocument(promptFile);
    await vscode.window.showTextDocument(doc, { preview: false });

    if (isInsideContainer()) {
      void vscode.window.showWarningMessage(
        "👻 Ghosteado: Synthetic workspace prepared. Rebuild or reopen the protected workspace from the host if you need the container mounts updated."
      );
    } else {
      const choice = await vscode.window.showInformationMessage(
        "👻 Ghosteado: Synthetic workspace prepared. Refresh container protection now to update the synthetic overlay?",
        "Refresh Container Protection",
        "Later"
      );
      if (choice === "Refresh Container Protection") {
        await refreshContainerProtection(workspaceRoot, false);
      }
    }
  }

  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage(
    writePromptFile
      ? `👻 Ghosteado: Synthetic prompt prepared for "${dataset.name}" and copied to the clipboard.`
      : `👻 Ghosteado: Simulation prompt copied for "${dataset.name}".`
  );
}

async function refreshContainerProtection(
  workspaceRoot: string,
  offerReopen: boolean
): Promise<boolean> {
  const manifest = loadManifest(workspaceRoot);
  if (manifest.protectedDatasets.length === 0) {
    if (offerReopen) {
      void vscode.window.showWarningMessage(
        "Ghosteado: Protect a dataset first before configuring the container."
      );
    }
    return false;
  }

  if (!(await checkPrerequisites())) return false;

  const language = mergePromptLanguages(
    manifest.protectedDatasets.map((dataset) => dataset.promptLanguage)
  );
  const containerWorkspaceRoot = resolveContainerWorkspaceRoot(workspaceRoot);
  const mounts = buildMountsFromProtectedDatasets(
    workspaceRoot,
    manifest.protectedDatasets.map((dataset) => ({
      workspaceFolderRel: dataset.workspaceFolderRel,
      syntheticFolderRel: dataset.syntheticFolderRel,
    })),
    containerWorkspaceRoot
  );
  const packages = await captureEnvironmentPackages(language);

  writeContainerFiles({
    workspaceRoot,
    language,
    mounts,
    rPackages: packages.rPackages,
    pythonPackages: packages.pythonPackages,
  });

  if (offerReopen) {
    const choice = await vscode.window.showInformationMessage(
      mounts.length > 0
        ? "Ghosteado: Container protection refreshed. Synthetic mount points are ready for the protected paths that have prepared workspaces."
        : "Ghosteado: Container protection refreshed. No synthetic mounts are prepared yet, so the container can generate code from schema but not run end-to-end reads.",
      "Reopen in Container",
      "Later"
    );
    if (choice === "Reopen in Container") {
      await reopenInContainer();
    }
  }

  return true;
}

async function resumeProtectedWorkspace(workspaceRoot: string): Promise<void> {
  const manifest = loadManifest(workspaceRoot);
  if (manifest.protectedDatasets.length === 0) {
    void vscode.window.showWarningMessage(
      "Ghosteado: No protected datasets were found in this workspace."
    );
    return;
  }

  if (isInsideContainer()) {
    void vscode.window.showInformationMessage(
      "Ghosteado: This workspace is already open inside the container."
    );
    return;
  }

  const issues = await validateProtectedWorkspacePaths(workspaceRoot, manifest);
  if (issues.length > 0) {
    void vscode.window.showErrorMessage(
      `Ghosteado: This protected workspace needs attention before reopening in the container.\n\n${formatIssueList(
        issues
      )}`
    );
    return;
  }

  const devcontainerPath = path.join(workspaceRoot, ".devcontainer", "devcontainer.json");
  if (!fs.existsSync(devcontainerPath) || containerProtectionNeedsRefresh(workspaceRoot, manifest)) {
    const ready = await refreshContainerProtection(workspaceRoot, false);
    if (!ready) return;
  }

  await reopenInContainer();
}

async function maybePromptToResume(workspaceRoot: string): Promise<void> {
  const manifest = loadManifest(workspaceRoot);
  if (manifest.protectedDatasets.length === 0 || isInsideContainer()) return;

  if (resumePromptShown) return;
  resumePromptShown = true;

  const choice = await vscode.window.showInformationMessage(
    "👻 Ghosteado detected a protected workspace. Resume in the container to keep AI work isolated from the real dataset.",
    "Resume in Container",
    "View Schema",
    "Later"
  );

  if (choice === "Resume in Container") {
    await resumeProtectedWorkspace(workspaceRoot);
  } else if (choice === "View Schema") {
    await viewSchema(workspaceRoot);
  }
}

function showStatusPanel(workspaceRoot: string): void {
  const manifest = loadManifest(workspaceRoot);
  const events = recentEvents(workspaceRoot, 20);
  const items: StatusQuickPickItem[] = [];

  items.push({
    label: "Protected Datasets",
    kind: vscode.QuickPickItemKind.Separator,
  });

  if (manifest.protectedDatasets.length === 0) {
    items.push({
      label: "$(circle-slash) None",
      description: "No protected datasets in this workspace",
    });
  } else {
    for (const dataset of manifest.protectedDatasets) {
      items.push({
        label: `$(shield) ${dataset.name}`,
        description: dataset.workspaceFolderRel,
        action: "openDatasetSchema",
        dataset,
        detail: hasPreparedSyntheticWorkspace(workspaceRoot, dataset)
          ? `Synthetic workspace: ${dataset.syntheticFolderRel}. Select to view the schema summary.`
          : "No synthetic workspace prepared yet. Select to view the schema summary.",
      });
    }
  }

  items.push({
    label: "Recent Host Warnings",
    kind: vscode.QuickPickItemKind.Separator,
  });

  if (events.length === 0) {
    items.push({
      label: "$(check) No host-side warnings recorded",
      description: "",
    });
  } else {
    for (const event of events) {
      items.push({
        label: `$(warning) ${path.basename(event.filePath)}`,
        description: `${event.operation} at ${new Date(event.timestamp).toLocaleTimeString()}`,
        detail: `${event.filePath} - Select to view the warning document.`,
        action: "openWarning",
        warningPath: event.filePath,
      });
    }
  }

  items.push({ label: "Actions", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(eye) View Schema", description: "", action: "viewSchema" });
  items.push({ label: "$(copy) Copy Simulation Prompt", description: "", action: "copyPrompt" });
  items.push({
    label: "$(file) Prepare Synthetic Data Prompt",
    description: "",
    action: "prepareSyntheticPrompt",
  });
  items.push({
    label: "$(sync) Refresh Container Protection",
    description: "",
    action: "refreshContainer",
  });
  items.push({ label: "$(refresh) Resume in Container", description: "", action: "resumeContainer" });
  items.push({ label: "$(trash) Clear access log", description: "", action: "clearLog" });

  void vscode.window
    .showQuickPick(items, {
      title: "Ghosteado Status",
      placeHolder: "Protected workspace overview",
      matchOnDescription: true,
    })
    .then(async (selected) => {
      if (!selected) return;
      if (selected.action === "openDatasetSchema" && selected.dataset) {
        await openSchemaDocument(workspaceRoot, selected.dataset);
      } else if (selected.action === "openWarning" && selected.warningPath) {
        const warningDoc = await vscode.workspace.openTextDocument(
          warningUri(selected.warningPath)
        );
        await vscode.window.showTextDocument(warningDoc, { preview: false });
      } else if (selected.action === "viewSchema") {
        await viewSchema(workspaceRoot);
      } else if (selected.action === "copyPrompt") {
        await copySimulationPrompt(workspaceRoot, false);
      } else if (selected.action === "prepareSyntheticPrompt") {
        await copySimulationPrompt(workspaceRoot, true);
      } else if (selected.action === "refreshContainer") {
        await refreshContainerProtection(workspaceRoot, true);
      } else if (selected.action === "resumeContainer") {
        await resumeProtectedWorkspace(workspaceRoot);
      } else if (selected.action === "clearLog") {
        await vscode.commands.executeCommand("ghosteado.clearLog");
      }
    });
}

function updateStatusBar(workspaceRoot: string): void {
  const manifest = loadManifest(workspaceRoot);
  const protectedCount = manifest.protectedDatasets.length;

  if (protectedCount === 0) {
    statusBarItem.text = "$(ghost) Ghosteado";
    statusBarItem.tooltip = "Ghosteado: no protected datasets";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  const inside = isInsideContainer();
  const prefix = inside ? "$(ghost) Container" : "$(ghost) Host";
  const blockSuffix =
    blockCount > 0 ? `  $(warning) ${blockCount} host warnings` : "";

  statusBarItem.text = `${prefix}: ${protectedCount} protected${blockSuffix}`;
  statusBarItem.tooltip = inside
    ? "Ghosteado: protected workspace is open inside the container"
    : "Ghosteado: protected workspace is open on the host. Resume in the container to keep AI work isolated.";
  statusBarItem.backgroundColor = inside
    ? undefined
    : new vscode.ThemeColor("statusBarItem.warningBackground");
  statusBarItem.show();
}

function loadProtectedFolders(): void {
  const cfg = vscode.workspace.getConfiguration("ghosteado");
  const folders = (cfg.get<string[]>("protectedFolders") ?? []).filter((folder) =>
    fs.existsSync(folder)
  );
  guard.setGhostedFolders(folders);
}

async function addProtectedFolder(folderPath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("ghosteado");
  const current = cfg.get<string[]>("protectedFolders") ?? [];
  if (!current.includes(folderPath)) {
    await cfg.update(
      "protectedFolders",
      [...current, folderPath],
      vscode.ConfigurationTarget.Workspace
    );
  }
}

async function removeProtectedFolder(folderPath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("ghosteado");
  const current = cfg.get<string[]>("protectedFolders") ?? [];
  await cfg.update(
    "protectedFolders",
    current.filter((item) => item !== folderPath),
    vscode.ConfigurationTarget.Workspace
  );
}

function ensureProjectDirectories(workspaceRoot: string): void {
  const manifestDir = path.join(workspaceRoot, MANIFEST_DIR);
  const srcDir = path.join(workspaceRoot, "src");

  if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir, { recursive: true });
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
}

async function protectDatasetOnHost(
  workspaceFolderPath: string,
  realDatasetPath: string
): Promise<void> {
  const source = path.resolve(workspaceFolderPath);
  const destination = path.resolve(realDatasetPath);

  if (fs.existsSync(destination)) {
    throw new Error(`Destination already exists at ${destination}`);
  }

  const parent = path.dirname(destination);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

  moveDirectory(source, destination);
  try {
    createDirectoryLink(destination, source);
  } catch (error) {
    moveDirectory(destination, source);
    throw error;
  }
}

function moveDirectory(source: string, destination: string): void {
  try {
    fs.renameSync(source, destination);
    return;
  } catch {
    fs.cpSync(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function createDirectoryLink(targetPath: string, linkPath: string): void {
  fs.symlinkSync(
    targetPath,
    linkPath,
    process.platform === "win32" ? "junction" : "dir"
  );
}

function resolveLinkedDatasetPath(linkPath: string): string | undefined {
  try {
    return fs.realpathSync(linkPath);
  } catch {
    return undefined;
  }
}

function loadManifest(workspaceRoot: string): ProtectedWorkspaceManifest {
  const filePath = manifestPath(workspaceRoot);
  if (!fs.existsSync(filePath)) {
    return {
      version: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      codeRootRel: "src",
      protectedDatasets: [],
    };
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ProtectedWorkspaceManifest;
  } catch {
    return {
      version: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      codeRootRel: "src",
      protectedDatasets: [],
    };
  }
}

function saveManifest(
  workspaceRoot: string,
  manifest: ProtectedWorkspaceManifest
): void {
  ensureProjectDirectories(workspaceRoot);
  fs.writeFileSync(
    manifestPath(workspaceRoot),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
}

function saveSchema(
  workspaceRoot: string,
  dataset: ProtectedDatasetManifest,
  schema: DatasetSchemaSummary
): void {
  ensureProjectDirectories(workspaceRoot);
  fs.writeFileSync(
    path.join(workspaceRoot, dataset.schemaFileRel),
    JSON.stringify(schema, null, 2) + "\n",
    "utf8"
  );
}

function loadSchema(
  workspaceRoot: string,
  dataset: ProtectedDatasetManifest
): DatasetSchemaSummary | undefined {
  const filePath = path.join(workspaceRoot, dataset.schemaFileRel);
  if (!fs.existsSync(filePath)) return undefined;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as DatasetSchemaSummary;
  } catch {
    return undefined;
  }
}

async function saveRealDatasetPath(
  workspaceRoot: string,
  datasetId: string,
  realDatasetPath: string
): Promise<void> {
  const map = extensionContext.globalState.get<RealPathMap>(REAL_PATHS_KEY, {});
  map[workspaceRoot] = map[workspaceRoot] ?? {};
  map[workspaceRoot][datasetId] = realDatasetPath;
  await extensionContext.globalState.update(REAL_PATHS_KEY, map);
}

async function loadRealDatasetPath(
  workspaceRoot: string,
  datasetId: string
): Promise<string | undefined> {
  const map = extensionContext.globalState.get<RealPathMap>(REAL_PATHS_KEY, {});
  return map[workspaceRoot]?.[datasetId];
}

async function removeRealDatasetPath(
  workspaceRoot: string,
  datasetId: string
): Promise<void> {
  const map = extensionContext.globalState.get<RealPathMap>(REAL_PATHS_KEY, {});
  if (!map[workspaceRoot]) return;
  delete map[workspaceRoot][datasetId];
  await extensionContext.globalState.update(REAL_PATHS_KEY, map);
}

async function pickProtectedDataset(
  workspaceRoot: string,
  manifest: ProtectedWorkspaceManifest,
  uri: vscode.Uri | undefined,
  title: string
): Promise<ProtectedDatasetManifest | undefined> {
  if (uri) {
    const targetPath = path.resolve(uri.fsPath);
    const matched = manifest.protectedDatasets.find(
      (dataset) =>
        path.resolve(workspaceRoot, dataset.workspaceFolderRel) === targetPath
    );
    if (matched) return matched;

    void vscode.window.showWarningMessage(
      `Ghosteado: "${path.basename(targetPath)}" is not a protected dataset folder in this workspace.`
    );
    return undefined;
  }

  if (manifest.protectedDatasets.length === 0) {
    void vscode.window.showWarningMessage(
      "Ghosteado: No protected datasets were found in this workspace."
    );
    return undefined;
  }

  if (manifest.protectedDatasets.length === 1) {
    return manifest.protectedDatasets[0];
  }

  const selected = await vscode.window.showQuickPick(
    manifest.protectedDatasets.map((dataset) => ({
      label: dataset.name,
      description: dataset.workspaceFolderRel,
      detail: dataset.syntheticFolderRel,
      dataset,
    })),
    {
      title,
      placeHolder: "Select a protected dataset",
      ignoreFocusOut: true,
    }
  );

  return selected?.dataset;
}

async function promptForSyntheticRowCount(): Promise<number | undefined> {
  const cfg = vscode.workspace.getConfiguration("ghosteado");
  const defaultValue = String(cfg.get<number>("simulatedRowCount") ?? 100);

  const value = await vscode.window.showInputBox({
    title: "Ghosteado - Synthetic data row count",
    prompt: "How many rows should the synthetic prompt target for tabular files?",
    value: defaultValue,
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 100_000) {
        return "Enter a number between 1 and 100000";
      }
      return undefined;
    },
  });

  if (value === undefined) return undefined;
  return Number.parseInt(value, 10);
}

function ensureSyntheticWorkspace(
  workspaceRoot: string,
  dataset: ProtectedDatasetManifest
): void {
  const dir = path.join(workspaceRoot, dataset.syntheticFolderRel);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function hasPreparedSyntheticWorkspace(
  workspaceRoot: string,
  dataset: ProtectedDatasetManifest
): boolean {
  const dir = path.join(workspaceRoot, dataset.syntheticFolderRel);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

function promptFilePath(
  workspaceRoot: string,
  dataset: ProtectedDatasetManifest
): string {
  return path.join(workspaceRoot, dataset.syntheticFolderRel, "SYNTHETIC_DATA_PROMPT.md");
}

function buildAnalysisPath(
  workspaceRoot: string,
  workspaceFolderRel: string
): string {
  const srcRoot = path.join(workspaceRoot, "src");
  const target = path.join(workspaceRoot, workspaceFolderRel);
  const rel = toPosix(path.relative(srcRoot, target));
  if (rel.startsWith(".")) return rel;
  return `./${rel}`;
}

function manifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, MANIFEST_DIR, MANIFEST_FILE);
}

function makeDatasetId(workspaceFolderRel: string): string {
  return workspaceFolderRel.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function hasOverlappingProtectedDataset(
  workspaceRoot: string,
  candidatePath: string,
  datasets: ProtectedDatasetManifest[]
): boolean {
  const normalizedCandidate = path.resolve(candidatePath);

  return datasets.some((dataset) => {
    const existingPath = path.resolve(workspaceRoot, dataset.workspaceFolderRel);
    return (
      normalizedCandidate === existingPath ||
      normalizedCandidate.startsWith(existingPath + path.sep) ||
      existingPath.startsWith(normalizedCandidate + path.sep)
    );
  });
}

async function validateProtectedWorkspacePaths(
  workspaceRoot: string,
  manifest: ProtectedWorkspaceManifest
): Promise<string[]> {
  const issues: string[] = [];

  for (const dataset of manifest.protectedDatasets) {
    const workspaceFolderPath = path.join(workspaceRoot, dataset.workspaceFolderRel);
    if (!fs.existsSync(workspaceFolderPath)) {
      issues.push(`Missing workspace path for "${dataset.name}" at ${dataset.workspaceFolderRel}.`);
      continue;
    }

    const realDatasetPath =
      (await loadRealDatasetPath(workspaceRoot, dataset.id)) ??
      resolveLinkedDatasetPath(workspaceFolderPath);
    if (!realDatasetPath) {
      issues.push(`Missing host path metadata for "${dataset.name}".`);
      continue;
    }

    if (!fs.existsSync(realDatasetPath)) {
      issues.push(`Missing external dataset for "${dataset.name}" at ${realDatasetPath}.`);
      continue;
    }

    let linked = false;
    try {
      linked = fs.lstatSync(workspaceFolderPath).isSymbolicLink();
    } catch {
      linked = false;
    }

    if (!linked && path.resolve(realDatasetPath) === path.resolve(workspaceFolderPath)) {
      issues.push(
        `"${dataset.name}" is no longer linked outside the workspace. Remove protection or protect the dataset again from the host workspace.`
      );
    }
  }

  return issues;
}

function containerProtectionNeedsRefresh(
  workspaceRoot: string,
  manifest: ProtectedWorkspaceManifest
): boolean {
  const devcontainerPath = path.join(workspaceRoot, ".devcontainer", "devcontainer.json");
  if (!fs.existsSync(devcontainerPath)) return true;

  try {
    const parsed = JSON.parse(fs.readFileSync(devcontainerPath, "utf8")) as Record<
      string,
      unknown
    >;
    const currentGhosteadoMounts = (Array.isArray(parsed.mounts) ? parsed.mounts : [])
      .filter((mount): mount is string => typeof mount === "string")
      .filter((mount) => mount.startsWith("source=${localWorkspaceFolder}/src/_simulated/"));

    const containerWorkspaceRoot = resolveContainerWorkspaceRoot(workspaceRoot);
    const expectedMounts = buildMountsFromProtectedDatasets(
      workspaceRoot,
      manifest.protectedDatasets.map((dataset) => ({
        workspaceFolderRel: dataset.workspaceFolderRel,
        syntheticFolderRel: dataset.syntheticFolderRel,
      })),
      containerWorkspaceRoot
    ).map(formatContainerMount);

    return (
      expectedMounts.length !== currentGhosteadoMounts.length ||
      expectedMounts.some((mount) => !currentGhosteadoMounts.includes(mount))
    );
  } catch {
    return true;
  }
}

function formatContainerMount(mount: ContainerMount): string {
  const readonly = mount.readonly ? ",readonly" : "";
  return `source=\${localWorkspaceFolder}/${mount.hostRelPath},target=${mount.containerPath},type=bind${readonly}`;
}

function formatIssueList(issues: string[]): string {
  const shown = issues.slice(0, 3).map((issue) => `- ${issue}`);
  if (issues.length > 3) {
    shown.push(`- ...and ${issues.length - 3} more`);
  }
  return shown.join("\n");
}

function mergePromptLanguages(languages: PromptLanguage[]): PromptLanguage {
  const filtered = new Set(languages.filter((language) => language !== "none"));
  if (filtered.has("both")) return "both";
  if (filtered.has("r") && filtered.has("python")) return "both";
  if (filtered.has("r")) return "r";
  if (filtered.has("python")) return "python";
  return "none";
}

async function addSearchExclusion(
  folderPath: string,
  workspaceRoot: string
): Promise<void> {
  const rel = toPosix(path.relative(workspaceRoot, folderPath));
  const wsConfig = vscode.workspace.getConfiguration();
  const searchExclude = {
    ...(wsConfig.get<Record<string, boolean>>("search.exclude") ?? {}),
  };
  searchExclude[`${rel}/**`] = true;
  await wsConfig.update(
    "search.exclude",
    searchExclude,
    vscode.ConfigurationTarget.Workspace
  );
}

async function removeSearchExclusion(
  folderPath: string,
  workspaceRoot: string
): Promise<void> {
  const rel = toPosix(path.relative(workspaceRoot, folderPath));
  const wsConfig = vscode.workspace.getConfiguration();
  const searchExclude = {
    ...(wsConfig.get<Record<string, boolean>>("search.exclude") ?? {}),
  };
  delete searchExclude[`${rel}/**`];
  await wsConfig.update(
    "search.exclude",
    searchExclude,
    vscode.ConfigurationTarget.Workspace
  );
}

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
  const rel = toPosix(path.relative(workspaceRoot, folderPath));
  const block = `\n${GHOST_TAG}\n${rel}/\n${rel}/**\n`;

  if (fs.existsSync(folderPath) && !fs.lstatSync(folderPath).isSymbolicLink()) {
    const content = `${GHOST_TAG}\n*\n**/*\n`;
    for (const fileName of IGNORE_FILENAMES) {
      const filePath = path.join(folderPath, fileName);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, "utf8");
    }
  }

  for (const fileName of [...IGNORE_FILENAMES, ".gitignore"]) {
    const rootPath = path.join(workspaceRoot, fileName);
    if (fs.existsSync(rootPath)) {
      const existing = fs.readFileSync(rootPath, "utf8");
      if (!existing.includes(`${rel}/`)) fs.appendFileSync(rootPath, block, "utf8");
    } else if (fileName !== ".gitignore") {
      fs.writeFileSync(rootPath, block, "utf8");
    }
  }
}

function removeIgnoreFiles(folderPath: string, workspaceRoot: string): void {
  if (fs.existsSync(folderPath) && !fs.lstatSync(folderPath).isSymbolicLink()) {
    for (const fileName of IGNORE_FILENAMES) {
      const filePath = path.join(folderPath, fileName);
      if (fs.existsSync(filePath)) {
        const contents = fs.readFileSync(filePath, "utf8");
        if (contents.includes("Ghosteado")) fs.unlinkSync(filePath);
      }
    }
  }

  const rel = toPosix(path.relative(workspaceRoot, folderPath));
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\n?${GHOST_TAG}\\n${escaped}\\/\\n${escaped}\\/\\*\\*\\n?`, "g");

  for (const fileName of [...IGNORE_FILENAMES, ".gitignore"]) {
    const rootPath = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(rootPath)) continue;
    const before = fs.readFileSync(rootPath, "utf8");
    const after = before.replace(blockRe, "\n");
    if (after !== before) fs.writeFileSync(rootPath, after, "utf8");
  }
}

async function closeWarningTabs(placeholderUri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === placeholderUri.toString()
      ) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
