# 👻 Ghosteado v1.0.0

**Author:** Kevin Martinez-Folgar

Container-first data protection for VS Code workspaces.

Ghosteado is built for projects where analysis code should keep stable dataset paths, but AI-assisted work must happen in an isolated runtime that cannot reach the real dataset directly.

## Core workflow

1. Open the project in VS Code.
2. Right-click the dataset folder in Explorer.
3. Run `Ghosteado: Protect This Dataset`.
4. Ghosteado moves the real dataset outside the workspace.
5. The original workspace path becomes a host link to the real dataset, so local tools such as RStudio or Jupyter can keep using the same path.
6. Ghosteado creates or refreshes a devcontainer for AI work.
7. If you later prepare synthetic data under `src/_simulated/...`, the container can mount that synthetic workspace onto the original dataset path.

The security boundary is the container, not the editor warning.

## Path behavior

Ghosteado is designed so code can keep reading the same relative data path.

Example project layout:

```text
project/
├── src/
│   └── analysis.R
└── data/ -> /Users/you/Protected-Research-Data/project/data
```

From `src/analysis.R`, code can keep reading `../data/...`.

- Outside the container: `../data/...` resolves to the real dataset through the host link.
- Inside the container, with synthetic data prepared: `src/_simulated/data/...` is mounted onto `/workspace/data`, so `../data/...` resolves to synthetic files instead.
- Inside the container, without synthetic data prepared: code generation still works from schema, but direct reads from `../data/...` will fail.

Important disclaimer:

If no synthetic data exists, the container can still generate code from schema, but it cannot run end-to-end data reads. That is fine if the goal is code generation first. If you want runnable code in-container, synthetic data needs to exist and be mounted there.

## Commands

| Command | What it does |
| --- | --- |
| `Ghosteado: Protect This Dataset` | Runs the data protection wizard from Explorer or the command palette |
| `Ghosteado: View Schema` | Opens a local-only schema summary collected from the real dataset |
| `Ghosteado: Copy Simulation Prompt` | Copies a synthetic-data prompt based on the collected schema |
| `Ghosteado: Prepare Synthetic Data Prompt` | Creates `src/_simulated/.../SYNTHETIC_DATA_PROMPT.md` and copies the prompt |
| `Ghosteado: Refresh Container Protection` | Rebuilds the devcontainer config and synthetic mounts |
| `Ghosteado: Resume Protected Workspace` | Reopens the protected workspace in the container |
| `Ghosteado: Remove Data Protection` | Moves the real dataset back into the workspace and removes protection |
| `Ghosteado: Show Protected Workspace Status` | Shows protected datasets and recent host-side warnings |

## What Ghosteado stores

Inside the workspace:

- `.ghosteado/project.json`: safe manifest for the protected workspace
- `.ghosteado/schema-*.json`: schema summaries collected from file structure and headers
- `src/_simulated/...`: optional synthetic workspace, only when you prepare it
- `.devcontainer/`: devcontainer config and package restore files

Outside the workspace:

- The real protected dataset

On the local machine:

- A mapping from protected dataset ids to their real host paths, stored through the extension state

## Schema workflow

Ghosteado does not create placeholder CSV files automatically anymore.

Instead it:

- reads only safe structural metadata such as file names, relative paths, and delimited headers
- infers column types from header names
- lets you view that schema locally
- builds prompts for synthetic data generation when you explicitly ask for them

This keeps prompt generation and synthetic generation separate from the protection step.

## Resume workflow

To continue work the next day:

1. Reopen the same project folder in VS Code.
2. Run `Ghosteado: Resume Protected Workspace`, or accept the resume prompt Ghosteado shows on startup.
3. VS Code reopens in the devcontainer.
4. Continue AI-assisted work there.

The protected workspace, schema manifest, and devcontainer config persist between sessions.

## Host warning mode

Ghosteado still keeps a host-side warning flow:

- protected dataset paths are tracked in `ghosteado.protectedFolders`
- if a protected path is opened directly on the host, Ghosteado can replace the editor tab with a warning document
- this is only a warning and recovery mechanism, not the main protection model

## Installation

```bash
npm install
npm run compile
npm install -g @vscode/vsce
vsce package
```

Install the resulting `.vsix` from VS Code or with:

```bash
code --install-extension ghosteado-1.0.0.vsix
```

## Prerequisites

- Docker Desktop
- VS Code Dev Containers extension
- Node 18+ and npm 9+ for building from source

## Notes

- Use AI tools inside the container if you want the isolation boundary to hold.
- The host link keeps direct dataset paths working for local RStudio or Jupyter workflows.
- Synthetic data is optional and explicit.
- Re-run `Ghosteado: Refresh Container Protection` after preparing a synthetic workspace if you want the new overlay reflected in the devcontainer config.
