"use strict";
/**
 * devcontainer.ts
 * Container support for Ghosteado's container-first workflow.
 *
 * The host workspace keeps a stable dataset path for local tools via a link.
 * Inside the container, Ghosteado can overlay src/_simulated/... onto that
 * same workspace path so code reads synthetic data instead of the real dataset.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isInsideContainer = isInsideContainer;
exports.isDockerAvailable = isDockerAvailable;
exports.isDevContainersInstalled = isDevContainersInstalled;
exports.checkPrerequisites = checkPrerequisites;
exports.detectRVersion = detectRVersion;
exports.detectPythonVersion = detectPythonVersion;
exports.captureEnvironmentPackages = captureEnvironmentPackages;
exports.buildMountsFromProtectedDatasets = buildMountsFromProtectedDatasets;
exports.resolveContainerWorkspaceRoot = resolveContainerWorkspaceRoot;
exports.writeContainerFiles = writeContainerFiles;
exports.reopenInContainer = reopenInContainer;
exports.clearContainerFiles = clearContainerFiles;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const child_process_1 = require("child_process");
const GENERATED_FILES = [
    "ghosteado-install_r_packages.R",
    "ghosteado-r-packages.txt",
    "ghosteado-requirements.txt",
    "GHOSTEADO_CONTAINER.md",
];
const R_BASE_PACKAGES = new Set([
    "base",
    "boot",
    "class",
    "cluster",
    "codetools",
    "compiler",
    "datasets",
    "foreign",
    "graphics",
    "grDevices",
    "grid",
    "KernSmooth",
    "lattice",
    "MASS",
    "Matrix",
    "methods",
    "mgcv",
    "nlme",
    "nnet",
    "parallel",
    "rpart",
    "spatial",
    "splines",
    "stats",
    "stats4",
    "survival",
    "tcltk",
    "tools",
    "translations",
    "utils",
]);
function isInsideContainer() {
    return (!!process.env.REMOTE_CONTAINERS ||
        !!process.env.CODESPACES ||
        fs.existsSync("/.dockerenv"));
}
function isDockerAvailable() {
    try {
        (0, child_process_1.execSync)("docker --version", {
            encoding: "utf8",
            timeout: 5000,
            stdio: "pipe",
        });
        return true;
    }
    catch {
        return false;
    }
}
function isDevContainersInstalled() {
    return !!vscode.extensions.getExtension("ms-vscode-remote.remote-containers");
}
async function checkPrerequisites() {
    if (isInsideContainer()) {
        vscode.window.showWarningMessage("Ghosteado: This command configures the host workspace. Reopen the folder on the host to update container protection.");
        return false;
    }
    if (!isDockerAvailable()) {
        const choice = await vscode.window.showErrorMessage("Ghosteado: Docker Desktop is required for container isolation.", "Download Docker Desktop", "Cancel");
        if (choice === "Download Docker Desktop") {
            void vscode.env.openExternal(vscode.Uri.parse("https://www.docker.com/products/docker-desktop/"));
        }
        return false;
    }
    if (!isDevContainersInstalled()) {
        const choice = await vscode.window.showWarningMessage("Ghosteado: The Dev Containers extension is required.", "Install Extension", "Cancel");
        if (choice === "Install Extension") {
            void vscode.commands.executeCommand("workbench.extensions.installExtension", "ms-vscode-remote.remote-containers");
        }
        return false;
    }
    return true;
}
function detectRVersion() {
    try {
        const out = (0, child_process_1.execSync)("Rscript -e \"cat(paste0(R.version$major, '.', R.version$minor))\"", { encoding: "utf8", timeout: 10000, stdio: "pipe", shell: "/bin/sh" }).trim();
        return out || null;
    }
    catch {
        return null;
    }
}
function detectPythonVersion() {
    for (const cmd of ["python3 --version", "python --version"]) {
        try {
            const out = (0, child_process_1.execSync)(cmd, {
                encoding: "utf8",
                timeout: 5000,
                stdio: "pipe",
                shell: "/bin/sh",
            });
            const match = (out || "").match(/Python (\d+\.\d+)/);
            if (match)
                return match[1];
        }
        catch (error) {
            const stderr = error.stderr ?? "";
            const match = stderr.match(/Python (\d+\.\d+)/);
            if (match)
                return match[1];
        }
    }
    return null;
}
async function captureEnvironmentPackages(language) {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Ghosteado: Capturing host packages for the container...",
        cancellable: false,
    }, async (progress) => {
        let rPackages = [];
        let pythonPackages = [];
        if (language === "r" || language === "both") {
            progress.report({ message: "Reading R packages..." });
            rPackages = captureRPackages() ?? [];
        }
        if (language === "python" || language === "both") {
            progress.report({ message: "Reading Python packages..." });
            pythonPackages = capturePythonPackages() ?? [];
        }
        return { rPackages, pythonPackages };
    });
}
function buildMountsFromProtectedDatasets(workspaceRoot, datasets, containerWorkspaceRoot) {
    const mounts = [];
    const normalizedRoot = containerWorkspaceRoot.replace(/\/+$/, "");
    for (const dataset of datasets) {
        const syntheticDir = path.join(workspaceRoot, dataset.syntheticFolderRel);
        if (!fs.existsSync(syntheticDir) || !fs.statSync(syntheticDir).isDirectory()) {
            continue;
        }
        mounts.push({
            hostRelPath: toPosix(dataset.syntheticFolderRel),
            containerPath: `${normalizedRoot}/${toPosix(dataset.workspaceFolderRel)}`,
            readonly: false,
        });
    }
    return mounts;
}
function resolveContainerWorkspaceRoot(workspaceRoot) {
    const jsonPath = path.join(workspaceRoot, ".devcontainer", "devcontainer.json");
    if (!fs.existsSync(jsonPath))
        return "/workspace";
    try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const workspaceFolder = parsed.workspaceFolder;
        if (typeof workspaceFolder === "string" && workspaceFolder.startsWith("/")) {
            return workspaceFolder.replace(/\/+$/, "");
        }
        const workspaceMountTarget = parseWorkspaceMountTarget(parsed.workspaceMount);
        if (workspaceMountTarget) {
            return workspaceMountTarget;
        }
    }
    catch {
        // fall through to default
    }
    return "/workspace";
}
function writeContainerFiles(cfg) {
    const dcDir = path.join(cfg.workspaceRoot, ".devcontainer");
    if (!fs.existsSync(dcDir))
        fs.mkdirSync(dcDir, { recursive: true });
    const jsonPath = path.join(dcDir, "devcontainer.json");
    let jsonContent;
    if (fs.existsSync(jsonPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
            const ghosteado = existing.ghosteado;
            if (ghosteado?.managed && ghosteado.mode === "merged" && ghosteado.baseConfig) {
                jsonContent = mergeDevcontainer(ghosteado.baseConfig, cfg);
            }
            else if (ghosteado?.managed) {
                jsonContent = buildDevcontainerJson(cfg);
            }
            else {
                jsonContent = mergeDevcontainer(existing, cfg);
            }
        }
        catch {
            jsonContent = buildDevcontainerJson(cfg);
        }
    }
    else {
        jsonContent = buildDevcontainerJson(cfg);
    }
    fs.writeFileSync(jsonPath, JSON.stringify(jsonContent, null, 2) + "\n", "utf8");
    if (cfg.rPackages.length > 0) {
        fs.writeFileSync(path.join(dcDir, "ghosteado-install_r_packages.R"), generateRInstallScript(cfg.rPackages), "utf8");
        fs.writeFileSync(path.join(dcDir, "ghosteado-r-packages.txt"), cfg.rPackages.join("\n") + "\n", "utf8");
    }
    if (cfg.pythonPackages.length > 0) {
        fs.writeFileSync(path.join(dcDir, "ghosteado-requirements.txt"), "# Auto-generated by Ghosteado\n" + cfg.pythonPackages.join("\n") + "\n", "utf8");
    }
    fs.writeFileSync(path.join(dcDir, "GHOSTEADO_CONTAINER.md"), generateContainerReadme(cfg), "utf8");
    cleanupGeneratedFiles(dcDir, cfg);
}
function reopenInContainer() {
    return vscode.commands.executeCommand("remote-containers.reopenInContainer");
}
function clearContainerFiles(workspaceRoot) {
    const dcDir = path.join(workspaceRoot, ".devcontainer");
    const jsonPath = path.join(dcDir, "devcontainer.json");
    if (!fs.existsSync(jsonPath))
        return;
    try {
        const existing = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const ghosteado = existing.ghosteado;
        if (ghosteado?.managed && ghosteado.mode === "merged" && ghosteado.baseConfig) {
            fs.writeFileSync(jsonPath, JSON.stringify(ghosteado.baseConfig, null, 2) + "\n", "utf8");
        }
        else if (ghosteado?.managed) {
            fs.rmSync(jsonPath, { force: true });
        }
        for (const fileName of GENERATED_FILES) {
            fs.rmSync(path.join(dcDir, fileName), { force: true });
        }
        if (fs.existsSync(dcDir) && fs.readdirSync(dcDir).length === 0) {
            fs.rmdirSync(dcDir);
        }
    }
    catch {
        // Keep cleanup best-effort so unprotect can continue.
    }
}
function captureRPackages() {
    try {
        const out = (0, child_process_1.execSync)("Rscript -e \"ip<-installed.packages()[,c('Package','Version')];" +
            "cat(paste(ip[,'Package'],ip[,'Version'],sep='@',collapse='\\n'))\"", { encoding: "utf8", timeout: 30000, stdio: "pipe", shell: "/bin/sh" });
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .filter((line) => !R_BASE_PACKAGES.has(line.split("@")[0]));
    }
    catch {
        return null;
    }
}
function capturePythonPackages() {
    for (const cmd of ["pip3 freeze", "pip freeze"]) {
        try {
            const out = (0, child_process_1.execSync)(cmd, {
                encoding: "utf8",
                timeout: 15000,
                stdio: "pipe",
                shell: "/bin/sh",
            });
            return out
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0 &&
                !line.startsWith("#") &&
                !line.startsWith("-e"));
        }
        catch {
            continue;
        }
    }
    return null;
}
function defaultImage(language, rVersion, pyVersion) {
    switch (language) {
        case "r":
            return rVersion ? `rocker/verse:${rVersion}` : "rocker/verse";
        case "python":
            return pyVersion
                ? `mcr.microsoft.com/devcontainers/python:${pyVersion}`
                : "mcr.microsoft.com/devcontainers/python:3";
        case "both":
            return rVersion ? `rocker/verse:${rVersion}` : "rocker/verse";
        default:
            return "mcr.microsoft.com/devcontainers/base:ubuntu-22.04";
    }
}
function buildDevcontainerJson(cfg) {
    const rVersion = detectRVersion();
    const pyVersion = detectPythonVersion();
    const image = cfg.baseImage ?? defaultImage(cfg.language, rVersion, pyVersion);
    const mounts = cfg.mounts.map((mount) => {
        const source = mount.hostRelPath.replace(/\\/g, "/");
        const readonly = mount.readonly ? ",readonly" : "";
        return `source=\${localWorkspaceFolder}/${source},target=${mount.containerPath},type=bind${readonly}`;
    });
    const postCreateCommands = [];
    if (cfg.language === "both") {
        postCreateCommands.push("apt-get update -qq && apt-get install -y python3 python3-pip 2>/dev/null || true");
    }
    if (cfg.rPackages.length > 0) {
        postCreateCommands.push("Rscript .devcontainer/ghosteado-install_r_packages.R");
    }
    if (cfg.pythonPackages.length > 0) {
        postCreateCommands.push("python3 -m pip install --quiet -r .devcontainer/ghosteado-requirements.txt");
    }
    const extensions = ["GitHub.copilot"];
    if (cfg.language === "r" || cfg.language === "both") {
        extensions.push("reditorsupport.r");
    }
    if (cfg.language === "python" || cfg.language === "both") {
        extensions.push("ms-python.python", "ms-python.pylance");
    }
    const dc = {
        name: "👻 Ghosteado Protected Workspace",
        image,
        workspaceMount: "source=${localWorkspaceFolder},target=/workspace,type=bind,consistency=cached",
        workspaceFolder: "/workspace",
        containerEnv: {
            GHOSTEADO_CONTAINER: "1",
            GHOSTEADO_MANIFEST_PATH: "/workspace/.ghosteado/project.json",
        },
        customizations: {
            vscode: {
                extensions,
            },
        },
        ghosteado: {
            version: "1.0.0",
            managed: true,
            mode: "owned",
        },
    };
    if (mounts.length > 0)
        dc.mounts = mounts;
    if (postCreateCommands.length > 0) {
        dc.postCreateCommand = postCreateCommands.join(" && ");
    }
    return dc;
}
function mergeDevcontainer(baseConfig, cfg) {
    const fresh = buildDevcontainerJson(cfg);
    const merged = { ...stripGhosteado(baseConfig) };
    const existingMounts = merged.mounts ?? [];
    const newMounts = fresh.mounts ?? [];
    const mounts = [
        ...existingMounts,
        ...newMounts.filter((mount) => !existingMounts.includes(mount)),
    ];
    if (mounts.length > 0)
        merged.mounts = mounts;
    const existingPostCreate = merged.postCreateCommand;
    const newPostCreate = fresh.postCreateCommand;
    if (newPostCreate) {
        merged.postCreateCommand = existingPostCreate
            ? `${existingPostCreate} && ${newPostCreate}`
            : newPostCreate;
    }
    merged.containerEnv = {
        ...merged.containerEnv,
        ...fresh.containerEnv,
    };
    merged.customizations = mergeCustomizations(merged.customizations, fresh.customizations);
    merged.ghosteado = {
        version: "1.0.0",
        managed: true,
        mode: "merged",
        baseConfig: stripGhosteado(baseConfig),
    };
    return merged;
}
function generateRInstallScript(packages) {
    const packageNames = packages
        .map((pkg) => pkg.split("@")[0])
        .map((name) => JSON.stringify(name))
        .join(",\n  ");
    return [
        "# Auto-generated by Ghosteado",
        "",
        'if (!requireNamespace("pak", quietly = TRUE)) {',
        '  install.packages("pak", repos = "https://cloud.r-project.org", quiet = TRUE)',
        "}",
        "",
        "packages <- c(",
        `  ${packageNames}`,
        ")",
        "",
        'message(sprintf("Ghosteado: installing %d R packages", length(packages)))',
        "pak::pak(packages, ask = FALSE)",
    ].join("\n");
}
function generateContainerReadme(cfg) {
    const lines = [
        "# 👻 Ghosteado Container Protection",
        "",
        "This container is generated by Ghosteado.",
        "Author: Kevin Martinez-Folgar",
        "",
        "Behavior:",
        "- The host workspace keeps a stable dataset path for local tools.",
        "- Inside the container, Ghosteado can overlay src/_simulated onto that same path.",
        "- If no synthetic data exists yet, code generation can continue from schema, but end-to-end reads will fail until synthetic files are present.",
        "",
        "Synthetic mounts:",
    ];
    if (cfg.mounts.length === 0) {
        lines.push("- None prepared yet.");
    }
    else {
        for (const mount of cfg.mounts) {
            lines.push(`- ${mount.hostRelPath} -> ${mount.containerPath}${mount.readonly ? " (read-only)" : ""}`);
        }
    }
    return lines.join("\n");
}
function cleanupGeneratedFiles(dcDir, cfg) {
    if (cfg.rPackages.length === 0) {
        fs.rmSync(path.join(dcDir, "ghosteado-install_r_packages.R"), { force: true });
        fs.rmSync(path.join(dcDir, "ghosteado-r-packages.txt"), { force: true });
    }
    if (cfg.pythonPackages.length === 0) {
        fs.rmSync(path.join(dcDir, "ghosteado-requirements.txt"), { force: true });
    }
}
function mergeCustomizations(base, fresh) {
    if (!base && !fresh)
        return undefined;
    const baseVscode = base?.vscode ?? {};
    const freshVscode = fresh?.vscode ?? {};
    const baseExtensions = baseVscode.extensions ?? [];
    const freshExtensions = freshVscode.extensions ?? [];
    return {
        ...(base ?? {}),
        ...(fresh ?? {}),
        vscode: {
            ...baseVscode,
            ...freshVscode,
            extensions: Array.from(new Set([...baseExtensions, ...freshExtensions])),
        },
    };
}
function stripGhosteado(config) {
    const clone = JSON.parse(JSON.stringify(config));
    delete clone.ghosteado;
    return clone;
}
function parseWorkspaceMountTarget(workspaceMount) {
    if (typeof workspaceMount !== "string")
        return undefined;
    const match = workspaceMount.match(/(?:^|,)\s*(?:target|dst|destination)=([^,]+)/);
    if (!match)
        return undefined;
    const target = match[1].trim().replace(/^['"]|['"]$/g, "");
    if (!target.startsWith("/"))
        return undefined;
    return target.replace(/\/+$/, "");
}
function toPosix(value) {
    return value.replace(/\\/g, "/");
}
//# sourceMappingURL=devcontainer.js.map