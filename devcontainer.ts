/**
 * devcontainer.ts — Ghosteado Container Protection
 *
 * Captures the researcher's local R/Python environment and generates a
 * VS Code devcontainer configuration that:
 *   - Mounts _simulated/ at the ghosted data folder path (transparent to code)
 *   - Pre-installs all packages from the host environment (one-time, then cached)
 *   - Prevents AI agents from reaching real data at the OS level
 *
 * Entry points:
 *   runContainerWizard()  — full standalone wizard (command palette)
 *   runContainerStep()    — lightweight post-wizard step (called from wizard.ts)
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContainerMount {
  /** Path relative to workspace root on the host */
  hostRelPath: string;
  /** Absolute path inside the container */
  containerPath: string;
  readonly: boolean;
}

export interface DevcontainerConfig {
  workspaceRoot: string;
  language: "r" | "python" | "both" | "none";
  baseImage?: string;
  mounts: ContainerMount[];
  rPackages: string[];
  pythonPackages: string[];
}

// ── R base packages (already in any R install — no need to reinstall) ─────────

const R_BASE_PACKAGES = new Set([
  "base", "boot", "class", "cluster", "codetools", "compiler", "datasets",
  "foreign", "graphics", "grDevices", "grid", "KernSmooth", "lattice", "MASS",
  "Matrix", "methods", "mgcv", "nlme", "nnet", "parallel", "rpart", "spatial",
  "splines", "stats", "stats4", "survival", "tcltk", "tools", "translations",
  "utils",
]);

// ── Environment detection ─────────────────────────────────────────────────────

export function isInsideContainer(): boolean {
  return (
    !!process.env.REMOTE_CONTAINERS ||
    !!process.env.CODESPACES ||
    fs.existsSync("/.dockerenv")
  );
}

export function isDockerAvailable(): boolean {
  try {
    execSync("docker --version", { encoding: "utf8", timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function isDevContainersInstalled(): boolean {
  return !!vscode.extensions.getExtension("ms-vscode-remote.remote-containers");
}

export function detectRVersion(): string | null {
  try {
    const out = execSync(
      "Rscript -e \"cat(paste0(R.version$major, '.', R.version$minor))\"",
      { encoding: "utf8", timeout: 10000, stdio: "pipe", shell: "/bin/sh" }
    ).trim();
    // version string from R looks like "4.4.1" (major=4, minor=4.1 → "4.4.1")
    return out || null;
  } catch {
    return null;
  }
}

export function detectPythonVersion(): string | null {
  for (const cmd of ["python3 --version", "python --version"]) {
    try {
      // python --version writes to stderr on Python 2, stdout on Python 3
      const out = execSync(cmd, {
        encoding: "utf8", timeout: 5000, stdio: "pipe", shell: "/bin/sh",
      });
      const match = (out || "").match(/Python (\d+\.\d+)/);
      if (match) return match[1];
    } catch (e: unknown) {
      // python --version on Python 2 writes to stderr; try to read it
      const stderr = (e as { stderr?: string }).stderr ?? "";
      const m = stderr.match(/Python (\d+\.\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

// ── Package capture ───────────────────────────────────────────────────────────

/** Returns ["pkg@version", ...] or null if R not found. */
export function captureRPackages(): string[] | null {
  try {
    const out = execSync(
      "Rscript -e \"ip<-installed.packages()[,c('Package','Version')];" +
        "cat(paste(ip[,'Package'],ip[,'Version'],sep='@',collapse='\\n'))\"",
      { encoding: "utf8", timeout: 30000, stdio: "pipe", shell: "/bin/sh" }
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !R_BASE_PACKAGES.has(l.split("@")[0]));
  } catch {
    return null;
  }
}

/** Returns pip freeze lines or null if pip not found. */
export function capturePythonPackages(): string[] | null {
  for (const cmd of ["pip3 freeze", "pip freeze"]) {
    try {
      const out = execSync(cmd, {
        encoding: "utf8", timeout: 15000, stdio: "pipe", shell: "/bin/sh",
      });
      return out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("-e"));
    } catch { /* try next */ }
  }
  return null;
}

// ── Image selection ───────────────────────────────────────────────────────────

function defaultImage(
  language: DevcontainerConfig["language"],
  rVersion: string | null,
  pyVersion: string | null
): string {
  switch (language) {
    case "r":
      // Match the researcher's exact R version so packages compile correctly
      return rVersion ? `rocker/verse:${rVersion}` : "rocker/verse";
    case "python":
      return pyVersion
        ? `mcr.microsoft.com/devcontainers/python:${pyVersion}`
        : "mcr.microsoft.com/devcontainers/python:3";
    case "both":
      // rocker/verse is the base; Python installed via postCreateCommand
      return rVersion ? `rocker/verse:${rVersion}` : "rocker/verse";
    default:
      return "mcr.microsoft.com/devcontainers/base:ubuntu-22.04";
  }
}

// ── devcontainer.json builder ─────────────────────────────────────────────────

function buildDevcontainerJson(cfg: DevcontainerConfig): Record<string, unknown> {
  const rVer = detectRVersion();
  const pyVer = detectPythonVersion();
  const image = cfg.baseImage ?? defaultImage(cfg.language, rVer, pyVer);

  // Bind mounts: _simulated/ shadows the real data path inside the container
  const mounts = cfg.mounts.map((m) => {
    const src = m.hostRelPath.replace(/\\/g, "/");
    const ro = m.readonly ? ",readonly" : "";
    return `source=\${localWorkspaceFolder}/${src},target=${m.containerPath},type=bind${ro}`;
  });

  // postCreateCommand: restore packages (runs once; Docker caches it)
  const postCmds: string[] = [];
  if (cfg.rPackages.length > 0) {
    postCmds.push("Rscript .devcontainer/install_r_packages.R");
  }
  if (cfg.pythonPackages.length > 0) {
    postCmds.push("pip install --quiet -r .devcontainer/requirements.txt");
  }
  // For "both": ensure Python/pip are available in the rocker image
  if (cfg.language === "both" && !postCmds.some((c) => c.includes("pip"))) {
    postCmds.unshift(
      "apt-get update -qq && apt-get install -y python3-pip 2>/dev/null || true"
    );
  }

  // VS Code extensions to pre-install in the container
  const extensions: string[] = [];
  if (cfg.language === "r" || cfg.language === "both") {
    extensions.push("reditorsupport.r");
  }
  if (cfg.language === "python" || cfg.language === "both") {
    extensions.push("ms-python.python", "ms-python.pylance");
  }
  extensions.push("GitHub.copilot");

  const dc: Record<string, unknown> = {
    name: "Ghosteado — Protected Workspace",
    image,
    workspaceMount:
      "source=${localWorkspaceFolder},target=/workspace,type=bind,consistency=cached",
    workspaceFolder: "/workspace",
    customizations: { vscode: { extensions } },
    // Marker so future runs know which parts Ghosteado manages
    ghosteado: { version: "0.9.0", managed: true },
  };

  if (mounts.length > 0) dc.mounts = mounts;
  if (postCmds.length > 0) dc.postCreateCommand = postCmds.join(" && ");

  return dc;
}

// ── Merge into existing devcontainer.json ─────────────────────────────────────

function mergeDevcontainer(
  existing: Record<string, unknown>,
  cfg: DevcontainerConfig
): Record<string, unknown> {
  const fresh = buildDevcontainerJson(cfg);
  const merged = { ...existing };

  // Merge mounts array
  const existingMounts = (existing.mounts as string[] | undefined) ?? [];
  const newMounts = (fresh.mounts as string[] | undefined) ?? [];
  const combined = [
    ...existingMounts,
    ...newMounts.filter((m) => !existingMounts.includes(m)),
  ];
  if (combined.length > 0) merged.mounts = combined;

  // Append postCreateCommand
  const existingPost = existing.postCreateCommand as string | undefined;
  const newPost = fresh.postCreateCommand as string | undefined;
  if (newPost) {
    merged.postCreateCommand = existingPost
      ? `${existingPost} && ${newPost}`
      : newPost;
  }

  merged.ghosteado = { version: "0.9.0", managed: true, merged: true };
  return merged;
}

// ── R install script ──────────────────────────────────────────────────────────

function generateRInstallScript(packages: string[]): string {
  // package@version → just package names; pak handles versions better than install.packages
  const names = packages
    .map((p) => p.split("@")[0])
    .map((n) => JSON.stringify(n))
    .join(",\n  ");

  return [
    "# Auto-generated by Ghosteado — restores your R environment in the container.",
    "# This runs once when the devcontainer is created. Docker caches the result.",
    "",
    'if (!requireNamespace("pak", quietly = TRUE)) {',
    '  install.packages("pak", repos = "https://cloud.r-project.org", quiet = TRUE)',
    "}",
    "",
    "packages <- c(",
    `  ${names}`,
    ")",
    "",
    'message(sprintf("👻 Ghosteado: installing %d R packages — runs once, then cached.", length(packages)))',
    "pak::pak(packages, ask = FALSE)",
    'message("✓ R environment ready.")',
    "",
  ].join("\n");
}

// ── Container README ──────────────────────────────────────────────────────────

function generateContainerReadme(cfg: DevcontainerConfig): string {
  const mountLines = cfg.mounts.map(
    (m) => `  - \`${m.hostRelPath}\` → \`${m.containerPath}\` (read-only simulated data)`
  );

  return [
    "# Ghosteado — Container Protection",
    "",
    "Auto-generated by [Ghosteado](https://github.com/KevinMF/ghosteado) v0.9.0",
    "Author: Kevin Martinez-Folgar",
    "",
    "## What this container does",
    "",
    "- AI agents running inside this container **cannot reach your real data**",
    "- Simulated data is mounted at the original folder path so your code runs normally",
    "- Your R/Python packages from the host are pre-installed (one-time setup)",
    "",
    "## Mounts",
    "",
    ...(mountLines.length > 0 ? mountLines : ["  (none — data is already outside the workspace)"]),
    "",
    "## Workflow",
    "",
    "1. Work inside the container — write code, get AI help, run tests against simulated data",
    "2. Run final analysis **on the host** (outside container) with real data",
    "3. If you add new CSV files to your real data, run **Ghosteado: Regenerate Simulated Data**",
    "4. If your packages change, re-run **Ghosteado: Add Container Protection** and rebuild",
    "",
    "## Rebuilding",
    "",
    "If packages or mounts change: open the Command Palette → **Dev Containers: Rebuild Container**",
    "",
  ].join("\n");
}

// ── Write all generated files ─────────────────────────────────────────────────

export function writeContainerFiles(cfg: DevcontainerConfig): void {
  const dcDir = path.join(cfg.workspaceRoot, ".devcontainer");
  if (!fs.existsSync(dcDir)) fs.mkdirSync(dcDir, { recursive: true });

  // devcontainer.json — merge if one already exists and isn't Ghosteado-managed
  const jsonPath = path.join(dcDir, "devcontainer.json");
  let jsonContent: Record<string, unknown>;
  if (fs.existsSync(jsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
      const gm = existing.ghosteado as Record<string, unknown> | undefined;
      jsonContent = gm?.managed ? buildDevcontainerJson(cfg) : mergeDevcontainer(existing, cfg);
    } catch {
      jsonContent = buildDevcontainerJson(cfg);
    }
  } else {
    jsonContent = buildDevcontainerJson(cfg);
  }
  fs.writeFileSync(jsonPath, JSON.stringify(jsonContent, null, 2) + "\n", "utf8");

  // R packages
  if (cfg.rPackages.length > 0) {
    fs.writeFileSync(
      path.join(dcDir, "install_r_packages.R"),
      generateRInstallScript(cfg.rPackages),
      "utf8"
    );
    fs.writeFileSync(
      path.join(dcDir, "r-packages.txt"),
      cfg.rPackages.join("\n") + "\n",
      "utf8"
    );
  }

  // Python requirements
  if (cfg.pythonPackages.length > 0) {
    fs.writeFileSync(
      path.join(dcDir, "requirements.txt"),
      "# Auto-generated by Ghosteado\n" + cfg.pythonPackages.join("\n") + "\n",
      "utf8"
    );
  }

  // README
  fs.writeFileSync(path.join(dcDir, "README.md"), generateContainerReadme(cfg), "utf8");

  // Add .devcontainer to .gitignore entry for the packages list (not the config itself)
  // The devcontainer.json and scripts ARE committed; only r-packages.txt/requirements.txt
  // contain machine-specific info but are small and safe to commit.
}

// ── Determine mounts from ghosted folders ─────────────────────────────────────

export function buildMountsFromGhostedFolders(
  workspaceRoot: string,
  ghostedFolders: string[]
): ContainerMount[] {
  const mounts: ContainerMount[] = [];

  for (const folderPath of ghostedFolders) {
    const simDir = path.join(folderPath, "_simulated");
    if (!fs.existsSync(simDir)) continue;

    const rel = path.relative(workspaceRoot, folderPath).replace(/\\/g, "/");
    const simRel = path.relative(workspaceRoot, simDir).replace(/\\/g, "/");

    mounts.push({
      hostRelPath: simRel,
      containerPath: `/workspace/${rel}`,
      readonly: true,
    });
  }

  return mounts;
}

// ── Prerequisite checks (UI) ──────────────────────────────────────────────────

async function checkPrerequisites(): Promise<boolean> {
  // Must not be inside a container already
  if (isInsideContainer()) {
    vscode.window.showWarningMessage(
      "👻 Ghosteado: You're already inside a container. " +
        "To update the configuration, edit .devcontainer/devcontainer.json on the host " +
        "and rebuild via Dev Containers: Rebuild Container."
    );
    return false;
  }

  // Docker must be available
  if (!isDockerAvailable()) {
    const choice = await vscode.window.showErrorMessage(
      "👻 Ghosteado: Docker Desktop is not installed. " +
        "Install it to enable container isolation.",
      "Download Docker Desktop",
      "Cancel"
    );
    if (choice === "Download Docker Desktop") {
      vscode.env.openExternal(vscode.Uri.parse("https://www.docker.com/products/docker-desktop/"));
    }
    return false;
  }

  // Dev Containers extension must be installed
  if (!isDevContainersInstalled()) {
    const choice = await vscode.window.showWarningMessage(
      "👻 Ghosteado: The 'Dev Containers' VS Code extension is required.",
      "Install Extension",
      "Cancel"
    );
    if (choice === "Install Extension") {
      vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        "ms-vscode-remote.remote-containers"
      );
    }
    return false;
  }

  return true;
}

// ── Full standalone wizard (command palette entry point) ──────────────────────

export async function runContainerWizard(workspaceRoot: string): Promise<void> {
  if (!(await checkPrerequisites())) return;

  // ── Language selection ──────────────────────────────────────────────────────
  const langPick = await vscode.window.showQuickPick(
    [
      {
        label: "$(file-code) R",
        description: "rocker/verse — tidyverse and your installed packages included",
        value: "r",
      },
      {
        label: "$(file-code) Python",
        description: "Python devcontainer — your pip packages included",
        value: "python",
      },
      {
        label: "$(files) Both R and Python",
        description: "rocker/verse base + Python and pip packages",
        value: "both",
      },
      {
        label: "$(circle-slash) No specific language",
        description: "Ubuntu base image — install tools manually",
        value: "none",
      },
    ],
    {
      title: "Ghosteado — Container Protection (1/3): Analysis language",
      placeHolder: "What language do you use for data analysis?",
      ignoreFocusOut: true,
    }
  );
  if (!langPick) return;
  const language = langPick.value as DevcontainerConfig["language"];

  // ── Custom image? ───────────────────────────────────────────────────────────
  const customImagePick = await vscode.window.showQuickPick(
    [
      {
        label: "$(cloud-download) Use Ghosteado's recommended image",
        description: "Best choice for most researchers",
        value: "default",
      },
      {
        label: "$(gear) Use my lab's existing Docker image",
        description: "Specify an image name (e.g. mylab/r-analysis:latest)",
        value: "custom",
      },
    ],
    {
      title: "Ghosteado — Container Protection (2/3): Base image",
      placeHolder: "Choose a Docker base image",
      ignoreFocusOut: true,
    }
  );
  if (!customImagePick) return;

  let baseImage: string | undefined;
  if (customImagePick.value === "custom") {
    const rVer = detectRVersion();
    const pyVer = detectPythonVersion();
    const placeholder = defaultImage(language, rVer, pyVer);
    baseImage = await vscode.window.showInputBox({
      title: "Ghosteado — Enter your Docker image name",
      prompt: "Full image name, e.g. rocker/verse:4.4.1 or mylab/r-analysis:latest",
      value: placeholder,
      ignoreFocusOut: true,
    });
    if (!baseImage) return;
  }

  // ── Capture packages with progress ─────────────────────────────────────────
  const { rPackages, pythonPackages } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "👻 Ghosteado: Capturing your installed packages...",
      cancellable: false,
    },
    async (progress) => {
      let rPkgs: string[] = [];
      let pyPkgs: string[] = [];

      if (language === "r" || language === "both") {
        progress.report({ message: "Reading R packages (may take a few seconds)..." });
        const captured = captureRPackages();
        if (captured !== null) {
          rPkgs = captured;
        } else {
          vscode.window.showWarningMessage(
            "Ghosteado: R not found in PATH — the container will use the base image packages. " +
              "You can install additional packages inside the container."
          );
        }
      }

      if (language === "python" || language === "both") {
        progress.report({ message: "Reading Python packages..." });
        const captured = capturePythonPackages();
        if (captured !== null) {
          pyPkgs = captured;
        } else {
          vscode.window.showWarningMessage(
            "Ghosteado: pip not found — Python packages not captured. " +
              "You can install them inside the container."
          );
        }
      }

      return { rPackages: rPkgs, pythonPackages: pyPkgs };
    }
  );

  // ── Build mounts from ghosted folders ──────────────────────────────────────
  const cfg = vscode.workspace.getConfiguration("ghosteado");
  const ghostedFolders: string[] = cfg.get("protectedFolders") ?? [];
  const mounts = buildMountsFromGhostedFolders(workspaceRoot, ghostedFolders);

  // Warn if no _simulated/ found in any ghosted folder
  if (ghostedFolders.length > 0 && mounts.length === 0) {
    vscode.window.showWarningMessage(
      "Ghosteado: Ghosted folders found but no _simulated/ subfolders detected. " +
        "Run 'Ghosteado: Regenerate Simulated Data' first so the container has data to work with."
    );
  }

  // ── Confirm summary ─────────────────────────────────────────────────────────
  const rVer2 = detectRVersion();
  const pyVer2 = detectPythonVersion();
  const resolvedImage = baseImage ?? defaultImage(language, rVer2, pyVer2);

  const summaryLines = [
    `• Image: ${resolvedImage}`,
    rPackages.length > 0 ? `• R packages to restore: ${rPackages.length}` : "",
    pythonPackages.length > 0 ? `• Python packages to restore: ${pythonPackages.length}` : "",
    mounts.length > 0
      ? `• Data mounts:\n${mounts.map((m) => `    _simulated/ → container:${m.containerPath}`).join("\n")}`
      : "• No data mounts (data is already outside the workspace)",
    `• Writes: .devcontainer/devcontainer.json`,
  ]
    .filter(Boolean)
    .join("\n");

  const confirm = await vscode.window.showWarningMessage(
    `Ghosteado Container Protection (3/3):\n\n${summaryLines}`,
    { modal: true },
    "Generate Container Config"
  );
  if (confirm !== "Generate Container Config") return;

  // ── Write files ─────────────────────────────────────────────────────────────
  writeContainerFiles({
    workspaceRoot,
    language,
    baseImage,
    mounts,
    rPackages,
    pythonPackages,
  });

  // ── Offer to reopen in container ────────────────────────────────────────────
  const open = await vscode.window.showInformationMessage(
    "👻 Container config generated! Reopen the workspace in the container to activate protection.",
    "Reopen in Container",
    "Later"
  );
  if (open === "Reopen in Container") {
    vscode.commands.executeCommand("remote-containers.reopenInContainer");
  }
}

// ── Lightweight step called from the ghost wizard ─────────────────────────────

/**
 * Called after the ghost wizard completes. Offers container setup using the
 * language already chosen in Step 3, skipping the language QuickPick.
 */
export async function runContainerStep(
  workspaceRoot: string,
  wizardLanguages: ("r" | "python")[],
  ghostedFolderPath: string
): Promise<void> {
  const offer = await vscode.window.showInformationMessage(
    "👻 Add container isolation? This copies your R/Python packages into a Docker container " +
      "so AI agents cannot reach real data even via the terminal.",
    "Add Container Protection",
    "Skip"
  );
  if (offer !== "Add Container Protection") return;

  if (!(await checkPrerequisites())) return;

  const language: DevcontainerConfig["language"] =
    wizardLanguages.length === 2
      ? "both"
      : wizardLanguages[0] ?? "none";

  const { rPackages, pythonPackages } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "👻 Ghosteado: Capturing your installed packages...",
      cancellable: false,
    },
    async () => ({
      rPackages:
        language === "r" || language === "both" ? (captureRPackages() ?? []) : [],
      pythonPackages:
        language === "python" || language === "both" ? (capturePythonPackages() ?? []) : [],
    })
  );

  const simDir = path.join(ghostedFolderPath, "_simulated");
  const mounts: ContainerMount[] = fs.existsSync(simDir)
    ? [
        {
          hostRelPath: path
            .relative(workspaceRoot, simDir)
            .replace(/\\/g, "/"),
          containerPath: `/workspace/${path
            .relative(workspaceRoot, ghostedFolderPath)
            .replace(/\\/g, "/")}`,
          readonly: true,
        },
      ]
    : [];

  writeContainerFiles({ workspaceRoot, language, mounts, rPackages, pythonPackages });

  const open = await vscode.window.showInformationMessage(
    `👻 Container config generated! ${rPackages.length + pythonPackages.length} packages captured. ` +
      "Reopen in Container to activate.",
    "Reopen in Container",
    "Later"
  );
  if (open === "Reopen in Container") {
    vscode.commands.executeCommand("remote-containers.reopenInContainer");
  }
}
