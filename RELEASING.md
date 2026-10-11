# Releasing

Two placeholders must be replaced before the first public release. Everything
else is ready.

## 1. Replace `OWNER`

The repository URL appears as `OWNER` in these files:

- `package.json` (`repository`, `homepage`, `bugs`)
- `README.md` (badges, links)
- `README.zh.md` (badges, links)

One command from the repository root (PowerShell). It writes UTF-8 explicitly —
`Set-Content` without `-Encoding` defaults to ANSI on Windows PowerShell 5.1 and
would corrupt every non-ASCII character in `README.zh.md`:

```powershell
$utf8 = [System.Text.UTF8Encoding]::new($false)
Get-ChildItem -Recurse -File -Include *.json,*.md |
  Where-Object { $_.FullName -notmatch 'node_modules' } |
  ForEach-Object {
    $path = $_.FullName
    $text = [System.IO.File]::ReadAllText($path, $utf8).Replace('OWNER', 'your-github-user')
    [System.IO.File]::WriteAllText($path, $text, $utf8)
    Write-Host "updated $path"
  }
```

Then confirm nothing was mangled:

```powershell
Get-ChildItem -Recurse -File -Include *.md | ForEach-Object {
  [System.IO.File]::ReadAllText($_.FullName, [System.Text.UTF8Encoding]::new($false)) | Out-Null
}
```

Sanity check the result with `git diff --stat` — it should show only the URL
lines, and `README.zh.md` must still render Chinese text.

Also set the identity (optional but expected for a published package):

- `package.json` → `author` (defaults to "dsh-sidebar-browser-control contributors")
- `LICENSE` → the copyright holder line

## 2. Verify

```sh
npm run verify
```

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
