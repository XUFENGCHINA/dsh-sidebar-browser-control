# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-13

The release where the plugin can actually *operate* the built-in browser the way
a person does — fill forms, log in, and look at what is on screen — plus the
reporting fixes that were staged as 0.1.1 (never published on its own).

### Added

- `browser_page fill` — fill several fields in one call, matched by label, name,
  placeholder or type (not just a CSS selector), including checkboxes, radios and
  selects, with an optional submit. Passwords are masked in the result.
- `browser_page key` — press Enter/Tab/Escape/arrows on a focused element, with
  Enter submitting the surrounding form.
- `browser_page login` — find the account and password fields (including inside a
  same-origin iframe), fill them, submit, wait for the outcome and report it:
  which fields were found, whether the password field disappeared, the address it
  landed on and an excerpt of the page after login. The password is used once and
  never returned or logged by the plugin.
- `browser_page images` — list the pictures visible in the viewport with index,
  alt text, rendered and natural size, and source.
- `browser_page image` — hand one picture from the page to the model as an
  attachment, so it can be *seen*. HTTP(S) sources are fetched by the Host (the
  page's own `fetch` is bound by CORS), `data:`/`blob:`/canvas sources are decoded
  in the page. Authored for pages where the interesting content is a photo, chart,
  QR code or captcha.
- `browser_page screenshot` — capture the Browser pane itself and attach it. This
  deliberately does **not** use a native Electron capture API: the Host asks the
  page for the pane's geometry and then captures the DSH window with PrintWindow
  through PowerShell, cropping to that rectangle, so it also works while the
  window is covered by other applications.
- `browser_page wait` learned `url_contains`.
- `browser_tabs` reports the available capture routes
  (`guest`/`desktopCapturer`/`displayMedia` and the preload's exposed keys) as
  diagnostics, and `elements` now carries `type`, `name`, `label`, `placeholder`,
  `autocomplete`, `value` and `checked` for form fields.
- `/browser images`, `/browser image <N>` and `/browser screenshot`.

### Fixed

- `browser_control open`/`navigate` reported the guest's creation state
  (`about:blank#<lease>`, with that string as the title) instead of the page.
  Both now wait for the first document to commit and report that page's address
  and title, falling back to the requested address while it is still loading.
- `browser_page text`/`links`/`elements` returned empty content when the page had
  failed to load, which reads as "the page is empty". Page actions now detect
  Chromium's error page and fail with the reason; `navigate` reports a failed
  load as a note carrying the underlying error (`ERR_NAME_NOT_RESOLVED (-105)` …)
  instead of failing the whole call; `eval` still runs but says it is on an
  error page.
- `browser_page click` matched the largest element containing the text — often a
  container — and reported success while nothing happened. Candidates are ranked
  by exact text, then clickability, then size, so a link beats the block around
  it; clicking a non-actionable element with no page change now says so and
  points at `elements` for a precise selector.
- `browser_page click` on a link that opens a new window (DSH turns the popup
  request into a new sidebar tab) reported success while the original tab stayed
  put, leaving the caller with a stale tab id. It now reports the new tab as
  `opened_tab`/`opened_url` and says to continue with it.
- `browser_page links`/`elements` printed their list twice.

### Changed

- README install order: npm is now the primary path, GitHub follows, and a
  checkout stays the development path.
- Documented the development constraint that a Host-half change needs a DSH
  restart while a Client-half change hot-reloads through a bundle toggle
  (`CONTRIBUTING.md`).

### Notes

- `0.1.0` was published through npm's staged publishing, which leaves a
  `0.0.0-stage` placeholder version in the registry's version list. It is not
  `latest`, nothing installs it by default, and it is npm's own artifact of
  reserving the name during the staged window.

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
