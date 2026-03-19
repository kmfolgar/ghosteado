# Releases

## v0.9.0 — Container Protection

**File:** `ghosteado-0.9.0.vsix`

### How to publish a release on GitHub

1. Push source files to the repository (the `.vsix` is gitignored — don't commit it)
2. Go to **Releases → Draft a new release**
3. Tag: `v0.9.0`
4. Title: `Ghosteado v0.9.0 — Container Protection`
5. Attach `ghosteado-0.9.0.vsix` as a release asset
6. Users install via: Extensions panel → ⋯ → Install from VSIX…

### Install from command line

```bash
code --install-extension ghosteado-0.9.0.vsix
```

### Build from source

```bash
npm install
npm run compile
npm install -g @vscode/vsce
vsce package
```
