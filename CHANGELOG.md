# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-11

First release, verified end to end against DSH Desktop 0.2.0-rc.2 (Electron 44,
Windows x64).

### Added

- `browser_tabs` — list the tabs of DSH's built-in sidebar browser with live
  title, URL, owning session, panel state and whether page-level control is
  available.
- `browser_control` — `open`, `navigate`, `back`, `forward`, `reload`, `close`,
  `focus`, `expand`, `collapse`, `fullscreen`, `split`, `float`, `dock`,
  `external`.
- `browser_page` — `text`, `links`, `elements`, `eval`, `click`, `type`,
  `scroll`, `wait` inside the built-in browser's `<webview>` (Desktop).
- `/browser` human command (`open`, `tabs`, `back`, `forward`, `reload`, `close`,
  `focus`, `expand`, `collapse`, `fullscreen`, `split`, `float`, `dock`,
  `external`, `read`) running the same operations as the tools.
- Host half with four loopback routes (`hello`, `poll`, `result`, `status`),
  origin admission, focus-aware command routing and a long-poll bridge to the
  Web page; Client half driving `ctx.sidebarRight` and the Browser tab's
  `<webview>`.
- Session-scoped tab identity: an id that is ambiguous across sessions is
  reported and accepted as `<sessionId>#<tabId>`.
- Offline bridge test (`npm test`) that exercises handshake, long-poll
  delivery, result settling, tool rendering, the command path and origin
  refusal without a running DSH.
- `npm run verify:pack` release gate: packs the tarball, extracts it and proves
  the shipped file set is self-sufficient.

### Removed

- **Screenshots.** `webview.capturePage()` natively crashed the Electron
  renderer on the verified deployment (`Desktop renderer exited: crashed`, the
  whole app process tree restarted). The capability was removed rather than
  shipped as a landmine; the call returns an explicit refusal. See
  [docs/architecture.md](docs/architecture.md#why-there-is-no-screenshot).

### Known issues

- Page-level actions require the Desktop app; the Web profile's sandboxed
  iframe can only do tab and layout control.
- Tab and layout actions target the session currently on screen, which is
  `ctx.sidebarRight`'s own semantics.
- The plugin reads DOM markers owned by the shipped sidebar packages
  (`data-sidebar-browser-frame`, `data-sidebar-right-tab`); if those change,
  page-level actions degrade with an explicit error while tab and layout
  control keep working.
