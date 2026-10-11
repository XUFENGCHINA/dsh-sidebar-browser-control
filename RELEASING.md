# Releasing

The repository URL (`XUFENGCHINA/dsh-sidebar-browser-control`), the `author`
field and the `LICENSE` holder are already set for the first release. What
remains is the identity check, the verify run, and pushing/publishing.

## 1. Repository URL and identity

Nothing to replace. Forking or moving the project means updating these, and
`npm run check:release` refuses to publish while any `OWNER` placeholder is
back:

- `package.json` → `repository`, `homepage`, `bugs`, `author`
- `README.md` / `README.zh.md` → badges and documentation links
- `LICENSE` → the copyright holder line

If you do need a bulk replacement, write UTF-8 explicitly — `Set-Content`
without `-Encoding` defaults to ANSI on Windows PowerShell 5.1 and corrupts
every non-ASCII character in `README.zh.md`:

```powershell
$utf8 = [System.Text.UTF8Encoding]::new($false)
Get-ChildItem -Recurse -File -Include *.md,*.json |
  Where-Object { $_.FullName -notmatch 'node_modules|\.git\\' } |
  ForEach-Object {
    $path = $_.FullName
    $text = [System.IO.File]::ReadAllText($path, $utf8).Replace('OWNER', 'your-github-user')
    [System.IO.File]::WriteAllText($path, $text, $utf8)
    Write-Host "updated $path"
  }
```

Then confirm nothing was mangled and that the replacement actually happened —
`git diff --stat` must show the URL lines, and `README.zh.md` must still
contain Chinese text:

```powershell
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)   # throws on invalid bytes
Get-ChildItem -Recurse -File -Include *.md,*.json |
  Where-Object { $_.FullName -notmatch 'node_modules|\.git\\' } |
  ForEach-Object { [System.IO.File]::ReadAllText($_.FullName, $utf8) | Out-Null; "utf8 ok: $($_.Name)" }
```

The commits are authored as `XUFENGCHINA <XUFENGCHINA@users.noreply.github.com>`.
To re-author them with a different address:

```sh
git config user.name  "XUFENGCHINA"
git config user.email "you@example.com"
git rebase --root --exec "git commit --amend --no-edit --reset-author"
```

## 2. Verify

```sh
npm run check:release   # refuses to publish while a placeholder remains
npm run verify          # syntax + offline protocol test + packaged-artifact gate
```

`check:release` also runs automatically from `prepublishOnly`, so `npm publish`
aborts with a file-by-file list if step 1 was missed — a package whose
`repository` points at `github.com/OWNER/...` cannot reach the registry.

`npm test` is the offline protocol test; `npm run verify:pack` packs the tarball,
extracts it and imports the Host half from the extracted files, so a missing
`files` entry fails here instead of on a user's machine.

## 3. Git

The repository is already initialized with one commit, made under a neutral
placeholder identity (`dsh-sidebar-browser-control contributors
<noreply@example.com>`). Re-author it under your own name before pushing:

```sh
git config user.name  "Your Name"
git config user.email "you@example.com"
git commit --amend --reset-author --no-edit
```

Then publish the repository:

```sh
git remote add origin https://github.com/<you>/dsh-sidebar-browser-control.git
git push -u origin main
```

(`git init` / `git add -A` / `git commit` are only needed if you start from a
copy of the directory rather than this repository.)

## 4. npm

The name `dsh-sidebar-browser-control` was free on 2026-10-11 (check again:
`npm view dsh-sidebar-browser-control version`). DSH plugins are distributed
through npm, and `dshmarket` / the plugin manager can install them by package
name, so publishing is what makes the plugin discoverable.

```sh
npm login
npm publish            # publishConfig.access = public; prepublishOnly runs the tests
```

Then check the package page renders the icon and bilingual metadata from
`package.json` (`meta`, `icon`, `locale/*.json`).

## 5. Announce

Useful facts for a release post:

- It drives **DSH's own sidebar browser**, not a separate Chromium — no extra
  process, and the tabs keep the user's existing profile and logins within that
  workspace partition.
- It is installed as a normal bundle and can be removed without touching DSH.
- `dsh-browser-control` on npm is a different thing (CDP/Playwright control of
  external browsers); this plugin is the in-app counterpart.
- The screenshot capability is intentionally absent, with the verified crash
  evidence in `docs/architecture.md`.
