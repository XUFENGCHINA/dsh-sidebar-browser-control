# Contributing

Thanks for looking. This plugin is small enough to read in one sitting, and the
bar for a change is: **it must be verifiable without a running DSH.**

## Layout

| Path | Half | Notes |
|---|---|---|
| `index.js` | Host | operations, four loopback routes, three tools, `/browser` command |
| `client.js` | Client | runs in the DSH Web page: `ctx.sidebarRight` + `<webview>` |
| `test/bridge.test.mjs` | test | offline: stub context + real `node:http` + a fake Client half |
| `scripts/verify-pack.mjs` | test | packs the tarball and proves the shipped file set works |
| `scripts/debug-capture.mjs` | dev | runs the real window-capture code outside DSH |
| `docs/architecture.md` | docs | protocol, design decisions, DSH internals it depends on |

## Rules that exist for a reason

1. **The Host half must not import anything.** A profile-installed bundle lives
   in the profile's `node_modules`, not inside the DSH installation, so
   `@deepseek-ai/*` is not on its import path. `index.js` uses standard-library
   globals only (`Buffer`, `URL`, `setTimeout`) and registers tools as plain
   objects with raw JSON Schema in `parameters`.
2. **`client.js` is a classic script, not a module.** It is served by DSH's
   client-module loader, so it must keep the
   `window.__ModuleLoader__.load({ id: '<package name>', factory() {...} })`
   shape and must not contain `import` statements. `id` must equal the package
   name.
3. **Never call `webview.capturePage()`** (or other guest-side native capture).
   It crashed the Electron renderer on the verified deployment; see
   `docs/architecture.md#why-there-is-no-screenshot`. If you want screenshots,
   propose a main-process design instead and expect to prove it on a throwaway
   profile first.
4. **Scope tab lookups by session.** Sidebar layout tab ids (`tab1`, `tab2`, …)
   are unique per session only; any cross-session lookup by bare id is a bug.
5. **Keep the client's DOM coupling optional.** `browser_tabs`,
   `browser_control`'s lifecycle/layout actions and `/browser` must keep working
   through `ctx.sidebarRight` alone, with page-level actions degrading to an
   explicit error if the DOM markers are gone.

## Development loop

```sh
npm test              # offline bridge test, no DSH required
npm run verify        # syntax + bridge test + packaged-artifact check
```

To try a change inside a live DSH: install the directory as a bundle, then ask
the Host to re-scan it after every edit (the client bundle is served from a
snapshot, so editing `client.js` is not enough on its own):

```
plugin_manager { action: install_bundle, target: "<abs path to this directory>" }
plugin_manager { action: set_bundle, target: "dsh-sidebar-browser-control", enabled: false }
plugin_manager { action: set_bundle, target: "dsh-sidebar-browser-control", enabled: true }
```

**That toggle only reloads the Client half.** The Host half's ES module stays in
Node's module cache for the life of the process, so a change to `index.js` — the
tools, the routes, the capture pipeline — needs a **DSH restart** before it runs.
Plan host-side work in batches, and verify client-side behaviour live in between.

Then exercise it with the tools themselves (`browser_tabs`,
`browser_control { action: "open", url: "https://example.com" }`,
`browser_page { action: "text" }`) and **restore whatever UI state you touched**
(close the tabs you opened, collapse the panel if it was collapsed).

### Debugging the window capture

`screenshot`, `image` and the geometry maths need a real window, so they cannot
run in the offline test. Use the Host half's own code directly:

```sh
node scripts/debug-capture.mjs              # whole window
node scripts/debug-capture.mjs 720 30 560 780   # a pane-sized crop
```

It enumerates the DSH windows it can see (handle, visibility, iconic state,
rectangle), then captures and writes the PNG to the temp directory. A minimized
window is restored by that script, which makes DSH visible again.

Two Windows-specific rules the capture follows, both learned the hard way:

- The PowerShell script is **ASCII only** and is passed as `-EncodedCommand`
  (UTF-16LE base64). Windows PowerShell reads `.ps1` files as ANSI, so a
  non-ASCII script file — or a `-Command` string — is corrupted silently.
- Its lines end in **CRLF**: a here-string terminator is only recognised at the
  start of a line, and PS 5.1 does not accept an LF-only terminator when the
  script arrives through `-EncodedCommand`.

## Pull requests

- Keep the operation surface small. One operation, one implementation, two
  callers (tool + command) — do not add a second code path for the command.
- Add or extend a case in `test/bridge.test.mjs` for anything protocol-shaped,
  and say in the PR what you verified live versus offline.
- Update `CHANGELOG.md` under `Unreleased`.
- If you touch the DSH-facing surface (services, DOM markers, manifest fields),
  state the DSH version you tested against.
