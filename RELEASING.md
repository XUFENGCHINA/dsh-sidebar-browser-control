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
git push -u origin main
```

Create the repository on GitHub first and leave it **empty** (no README, no
`.gitignore`, no license) — otherwise the first push is rejected as
non-fast-forward. Git Credential Manager opens a browser login on the first
push; that is expected.

## 4. npm

The name `dsh-sidebar-browser-control` was free on 2026-10-11 (check again:
`npm view dsh-sidebar-browser-control version`). DSH plugins are distributed
through npm, and `dshmarket` / the plugin manager can install them by package
name, so publishing is what makes the plugin discoverable.

**The account must have 2FA enabled, or publishing is refused.** The registry
answers every publish attempt with

```
E403 … Two-factor authentication or granular access token with bypass 2fa
enabled is required to publish packages
```

and it does so *after* the tarball has been built and uploaded — passing
`--otp` does not help while the account itself has 2FA disabled
(`npm profile get` shows `two-factor auth: disabled`). Nothing is created on the
registry in that case; confirm with `npm view <name> version` (404 = not
published).

So publish with:

```sh
npm profile get                 # must show: two-factor auth: auth-and-writes
npm publish --access public --otp=<6-digit code>
```

The code comes from the authenticator app and expires in about 30 seconds, so
run the command and enter it in the same breath. Enabling 2FA:
npmjs.com → avatar → **Account** → **Two-factor authentication** → *Enable 2FA*
(authenticator app).

### When the second factor is a security key or passkey

WebAuthn (a security key, Windows Hello, a passkey in the OS or a password
manager) cannot produce the six-digit code the CLI asks for, so `--otp` is not an
option at all — and changing 2FA settings invalidates the CLI's session token
(`npm whoami` → `E401`), so a fresh `npm login` does not fix it either.

Publish with a granular access token instead:

1. npmjs.com → avatar → **Access Tokens** → **Generate New Token** →
   **Granular Access Token**
2. *Packages and scopes*: **Read and write** for this package (or all packages)
3. Enable **Bypass 2FA** — npm confirms the change with your security key
4. Use it for one publish without touching your saved login:

   ```powershell
   cd <this repository>
   "//registry.npmjs.org/:_authToken=npm_xxx" | Set-Content -Encoding ascii .npmrc.publish
   npm publish --access public --userconfig .npmrc.publish
   Remove-Item .npmrc.publish
   ```

   (`-Encoding ascii` matters: npm's rc parser does not accept a BOM.)

5. **Revoke the token afterwards**, or give it a short expiry — it bypasses 2FA by
   design. The published version stays published either way.

For automation (CI, a release script), the same token type is the answer; expose
it as `//registry.npmjs.org/:_authToken=…` in the environment or a temporary
`.npmrc` rather than in the repository. Note that npm is restricting bypass-2FA
tokens for direct publishing, so an authenticator-app account with `--otp`
remains the durable route.

`prepublishOnly` runs `check:release` and `verify` first, so a placeholder or a
broken tarball aborts the publish before anything reaches the registry.

Then confirm the result and that the published artifact actually installs:

```sh
npm view dsh-sidebar-browser-control version dist.tarball
temp=$(mktemp -d) && npm install --prefix "$temp" dsh-sidebar-browser-control
node -e "import('$temp/node_modules/dsh-sidebar-browser-control/index.js').then(m => console.log(m.name, m.inject))"
```

Check the package page renders the icon and bilingual metadata from
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
