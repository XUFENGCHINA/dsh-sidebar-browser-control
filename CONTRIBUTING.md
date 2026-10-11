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

Then exercise it with the tools themselves (`browser_tabs`,
`browser_control { action: "open", url: "https://example.com" }`,
`browser_page { action: "text" }`) and **restore whatever UI state you touched**
(close the tabs you opened, collapse the panel if it was collapsed).

## Pull requests

- Keep the operation surface small. One operation, one implementation, two
  callers (tool + command) — do not add a second code path for the command.
- Add or extend a case in `test/bridge.test.mjs` for anything protocol-shaped,
  and say in the PR what you verified live versus offline.
- Update `CHANGELOG.md` under `Unreleased`.
- If you touch the DSH-facing surface (services, DOM markers, manifest fields),
  state the DSH version you tested against.
