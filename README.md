# 👻 Ghosteado v0.9.0

**Author:** Kevin Martinez-Folgar

Genuine AI-agent data protection for VS Code. Built for researchers working with sensitive, confidential, or regulated data (clinical, genomic, patient-level CSV files).

---

## What it actually does

Ghosteado uses three layers of defense:

1. **Reactive interception** — when any file in a ghosted folder is opened in an editor tab, Ghosteado immediately closes it and replaces it with a read-only warning document. Agents see the warning, not the data.
2. **Search exclusion** — ghosted folders are added to `search.exclude` in workspace settings so agents cannot discover them via VS Code's file-search APIs.
3. **Ignore files** — `.copilotignore`, `.cursorignore`, `.continueignore`, `.codeiumignore`, `.tabnignore`, `.aiignore` are written inside the folder and at workspace root as a first-line hint for well-behaved tools.

### On ghost (via Setup Wizard):
1. **Optionally moves the folder** outside the workspace entirely (to a path you choose, e.g. `~/Protected-Research-Data/`)
2. **Registers the folder** with the blocking guard
3. **Writes ignore files** inside the folder and at workspace root
4. **Excludes from search** via workspace `search.exclude`
5. **Scans CSV headers** and generates a `_simulated/` subfolder with:
   - Deterministic placeholder CSV (same seed → same rows always)
   - Column types inferred from header names (`age`, `icd_code`, `sex`, `date`, `rate`, etc.)
   - A `.schema.txt` file per CSV showing inferred column types
   - A `SIMULATE_WITH_AI_<name>.md` **AI pre-prompt** you can paste into any AI agent to generate a more realistic simulation script
   - A README explaining the folder is synthetic

### On blocked access:
- The real file tab is **immediately closed**
- A **warning document** opens in its place:
  ```
  ⚠️  WARNING: This file was marked as sensitive, do not let the Agent open it.
  ```
- **Status bar** updates: `👻 2 ghosted  ⚠ 3 blocked`
- **Notification popup** with "Open Anyway" (for human users) and "View Log" buttons
- **Access log** persisted to `.ghosteado/access.log.json` (gitignored, last 500 events)

### "Open Anyway" — human bypass:
If you (a human) need to open a ghosted file, click **"Open Anyway"** in the notification. The file is added to a session bypass list and reopens normally. Agents won't click notification buttons.

### Your R/Python scripts:
Point them at the real paths as always — blocking only happens at the VS Code editor layer. Terminal, R sessions, and Python processes access the filesystem directly and are unaffected.

### On unghost:
If data was moved outside the workspace during setup, unghost **moves it back automatically** before removing the ghost. You can immediately resume working as normal.

---

## Usage

### Right-click any folder in Explorer
→ **👻 Ghosteado: Ghost This Folder** — launches the Setup Wizard
→ **🔓 Ghosteado: Remove Ghost** — unghosts and restores moved data

### Command Palette (`Ctrl+Shift+P`)
| Command | Description |
|---|---|
| `👻 Ghosteado: Data Protection Setup Wizard` | Launch wizard without pre-selecting a folder |
| `👻 Ghosteado: Ghost This Folder` | Same as right-click — launches wizard |
| `🔓 Ghosteado: Remove Ghost` | Unghost and restore any moved data |
| `Ghosteado: Show Status & Access Log` | View blocked attempts and ghosted folders |
| `Ghosteado: Clear Access Log` | Reset the log |
| `Ghosteado: Regenerate Simulated Data` | Re-scan CSVs and rebuild `_simulated/` |
| `🐳 Ghosteado: Add Container Protection` | Generate devcontainer config with your package environment |

### Status bar (bottom right)
| Display | Meaning |
|---|---|
| `👻 Ghosteado` | Loaded, nothing ghosted |
| `👻 2 ghosted` | 2 folders active, no attempts |
| `👻 2 ghosted  ⚠ 5 blocked` | 5 blocked access attempts this session |

Click to open the status panel.

---

## Setup Wizard

The wizard guides you through 4 steps:

**Step 1 — Pick sensitive folder**
Choose which folder contains your real data (skipped when launched from Explorer right-click).

**Step 2 — Data location strategy**
- **Move outside workspace** *(recommended)* — copies data to a folder you choose outside the project (e.g. `~/Protected-Research-Data/`). The workspace never has direct access.
- **Keep in place and ghost it** — data stays where it is; agents are blocked at the editor layer.

**Step 3 — Simulation script language**
- **R** / **Python** / **Both** — Ghosteado writes a `SIMULATE_WITH_AI_<name>.md` pre-prompt in `_simulated/`. Paste it into Copilot Chat, Cursor, or Claude and your AI writes a tailored simulation script.
- **Skip** — only the placeholder CSV is written; no AI prompt.

**Step 4 — Row count**
How many rows the placeholder CSV and the AI-generated script should produce (1 – 100,000).

A confirmation modal summarises all planned actions before anything is changed.

---

## Simulated data

When you ghost a folder containing CSVs, Ghosteado reads only the **first line** (headers) of each file and generates synthetic data in `_simulated/`:

```
data/
├── patients.csv              ← GHOSTED (real data)
├── incidence.csv             ← GHOSTED (real data)
└── _simulated/
    ├── README.md
    ├── patients.csv          ← fake placeholder, agent-visible
    ├── patients.schema.txt   ← inferred column types
    ├── SIMULATE_WITH_AI_patients.md  ← paste into your AI agent
    ├── incidence.csv         ← fake placeholder, agent-visible
    ├── SIMULATE_WITH_AI_incidence.md
    └── incidence.schema.txt
```

Column type inference handles:
`id`, `age`, `date`, `year`, `sex`, `icd`/`morphology`/`histology`, `count`, `rate`/`incidence`, `boolean`, `name`, `country`/`region`/`site`, `weight`/`bmi`/`score`, and generic integers/floats.

### AI pre-prompt workflow

1. Ghost your folder — Ghosteado writes `SIMULATE_WITH_AI_<name>.md` in `_simulated/`
2. Open the file and copy its contents (or click **"Copy Prompt"** in the notification)
3. Paste into Copilot Chat, Cursor, Claude, or any AI agent
4. The AI writes a realistic R or Python simulation script tailored to your columns
5. Point your agent at `_simulated/<name>.csv` for coding help; your real scripts use `../<name>.csv` as always

---

## 🐳 Container Protection (strongest isolation)

Container protection uses Docker to create a hard OS-level boundary. AI agents running inside the container **cannot reach real data even via the terminal or Claude Code CLI** — the files simply don't exist inside the container.

### What it generates

- `.devcontainer/devcontainer.json` — VS Code devcontainer config with:
  - The right base image for your language (R → `rocker/verse`, Python → Microsoft devcontainer)
  - Your **exact R/Python package environment** captured from your host machine and restored automatically on first container build
  - `_simulated/` mounted at the original data folder path so your code runs transparently
- `.devcontainer/install_r_packages.R` — auto-generated R restore script (if R selected)
- `.devcontainer/requirements.txt` — captured pip packages (if Python selected)

### Workflow

1. Run **🐳 Ghosteado: Add Container Protection** (Command Palette)
2. Choose your language — Ghosteado captures all your installed packages automatically
3. Click **Reopen in Container** when VS Code prompts
4. Work normally inside the container — AI sees simulated data, your code runs against it
5. Run final analysis **on the host** with real data (outside the container)

### Package capture

Ghosteado reads your local environment once:
- **R**: runs `installed.packages()`, filters out base packages, generates an install script using `pak` (parallel, fast)
- **Python**: runs `pip freeze`, writes `requirements.txt`

First container build installs all packages (~5–15 min). After that, Docker caches the result — subsequent starts are instant.

### Protection tiers

| Tier | Setup | VS Code agents | Claude Code CLI | Terminal |
|------|-------|---------------|-----------------|----------|
| Ghost in place | Wizard Step 2: Keep | Mostly | ❌ | ❌ |
| Move data out | Wizard Step 2: Move | ✅ | ❌ | ❌ |
| Move + container | Move + Container Protection | ✅ | ✅ | ✅ |

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (install once)
- VS Code **Dev Containers** extension (Ghosteado will offer to install it)

### Custom lab image

If your lab has an existing Docker image, Ghosteado will ask for it during setup and use it as the base instead of the default image.

---

## Installation

```bash
# Prerequisites: Node 18+, npm 9+
cd ghosteado
npm install
npm run compile

# Install packager (once)
npm install -g @vscode/vsce

# Build .vsix
vsce package

# Install in VS Code via Extensions panel → ⋯ → Install from VSIX...
# or:
code --install-extension ghosteado-0.2.0.vsix
```

Or press **F5** in VS Code with the folder open to launch an Extension Development Host for testing.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `ghosteado.protectedFolders` | `[]` | Auto-managed list of ghosted paths |
| `ghosteado.simulatedRowCount` | `20` | Rows in placeholder simulated CSVs |
| `ghosteado.simulatedSeed` | `42` | Seed for deterministic placeholder generation |
| `ghosteado.notifyOnBlock` | `"both"` | `"statusBar"`, `"notification"`, or `"both"` |

---

## Important notes

- Blocking works at the **VS Code editor layer** — it stops agents that open files in editor tabs
- Terminal processes, R sessions, Python scripts, and anything accessing the OS filesystem directly are **not** affected — your code still works
- The **move-outside-workspace** option (Step 2 of the wizard) gives the strongest protection: the workspace folder never contains the real data
- For IRB/GDPR/HIPAA regulated data, combine with OS-level permissions and encrypted storage
- The `.ghosteado/` folder is automatically gitignored (contains the access log and move records)
- Original files are **not deleted** when moved — Ghosteado copies them to the destination. Remove the originals manually after verifying the copy.
