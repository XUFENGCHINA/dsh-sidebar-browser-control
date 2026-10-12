# dsh-sidebar-browser-control

[![npm version](https://img.shields.io/npm/v/dsh-sidebar-browser-control?color=2563eb)](https://www.npmjs.com/package/dsh-sidebar-browser-control)
[![CI](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/actions/workflows/ci.yml/badge.svg)](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/LICENSE)
[![DSH](https://img.shields.io/badge/verified%20on-DSH%20Desktop%200.2.0--rc.2-4b5563.svg)](#compatibility)

**Let the agent drive DSH's own built-in browser** — the Browser tab in the
right-hand Sidebar — instead of launching a second Chromium.

[中文说明 →](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/README.zh.md)

```
you › open the docs page in the built-in browser and tell me what the API section says
agent › browser_control { action: "open", url: "https://example.com/docs" }
        browser_page   { action: "text" }
```

## Why not a CDP/Playwright plugin

There is already a DSH plugin that drives browsers over CDP
(`dsh-browser-control`). This one is the in-app counterpart, and the differences
are the point:

| | This plugin | CDP / Playwright wrapper |
|---|---|---|
| What it drives | the Browser tab DSH already ships | a separate browser process |
| Where you see it | in the Sidebar, next to your session | in another window |
| Extra runtime | none | a browser + driver |
| Logins | the workspace partition the tab already uses | whatever you set up |
| Reach | that tab only | any page, headless, screenshots |

Use this one when you want the agent to look at something *with* you, in the
place you are already working. Use a CDP wrapper when you need headless
automation, downloads or screenshots.

## What it can do

| Tool | Actions |
|---|---|
| `browser_tabs` | list open built-in-browser tabs: id, live title, URL, owning session, panel state, whether page control is available |
| `browser_control` | `open` · `navigate` · `back` · `forward` · `reload` · `close` · `focus` · `expand` · `collapse` · `fullscreen` · `split` · `float` · `dock` · `external` |
| `browser_page` | `text` · `links` · `elements` · `eval` · `click` · `type` · `scroll` · `wait` *(Desktop only)* |
| `/browser` | `open <url>` · `tabs` · `back` · `forward` · `reload` · `close` · `focus` · `expand` · `collapse` · `fullscreen` · `split` · `float` · `dock` · `external` · `read` |

The tools and the slash command share one implementation, so `/browser open …`
costs no model round trip and behaves exactly like the tool.

## Install

The plugin is a normal DSH bundle, so any spec the plugin manager accepts works.

**From npm** (published as `dsh-sidebar-browser-control`). Ask the agent, no
restart needed:

```
plugin_manager { action: install_bundle, target: "dsh-sidebar-browser-control" }
```

or with the CLI:

```sh
dsh plugin --profile desktop add dsh-sidebar-browser-control
```

**From GitHub**, if you prefer tracking `main`:

```
plugin_manager { action: install_bundle, target: "github:XUFENGCHINA/dsh-sidebar-browser-control" }
```

**From a checkout**, for development:

```sh
dsh plugin --profile desktop add link:/abs/path/to/checkout
```

Remove it with `plugin_manager { action: "remove_bundle", target: "dsh-sidebar-browser-control" }`.

After editing `client.js` in a checkout, ask the Host to re-scan the bundle
(`set_bundle` off, then on) — the client artifact is served from a snapshot.

## Use

Just ask, in any session whose Sidebar is on screen:

- "open `https://news.ycombinator.com` in the built-in browser and summarise the top 5"
- "in the built-in browser, click the *Sign in* link and tell me what the form asks for"
- "search Bing in the built-in browser for DeepSeek Harness and give me the first three results"
- `/browser open https://example.com` — straight from the composer, no model call

## How it works

The browser lives in the Web renderer, tools live in the Host, and DSH exposes no
supported Host → Client call to third-party plugins. So the plugin is two halves
joined by four loopback routes (a long-poll carries Host → Client commands, with
no timer in either direction), and all layout/navigation goes through
`ctx.sidebarRight` so the shipped address bar, history and restore logic stay
authoritative.

Full protocol, design decisions and the DSH internals it depends on:
[docs/architecture.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/docs/architecture.md).

## Security

`browser_page eval` runs arbitrary JavaScript inside the browser tab, with that
page's cookies — if you are logged in there, the agent can act as you in that
tab. Tool calls are logged with their arguments, but treat these tools like
letting someone read your screen. The four routes admit only the DSH application
origin (no cross-site CSRF) and only this plugin's own tools can enqueue a
command. Details:
[SECURITY.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/SECURITY.md).

## Compatibility

Verified end to end on **DSH Desktop 0.2.0-rc.2 / Electron 44 / Windows x64**:
list, open, navigate, back/forward/reload, read text, `eval`, list elements,
click, type + submit, float/dock, close, expand/collapse. The Web profile gets
tab and layout control (its sandboxed iframe cannot be read).

The plugin talks to public services (`ctx.sidebarRight`, `ctx.webServer`,
`ctx.tools`, `ctx.commands`) plus a few DOM markers owned by the shipped Sidebar
packages. If a marker changes, page-level actions fail with an explicit message
while tab and layout control keep working; the table of those dependencies is in
[docs/architecture.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/docs/architecture.md#dsh-internals-this-plugin-depends-on).

## Known limitations

- **No screenshots.** `webview.capturePage()` natively crashed the Electron
  renderer on the verified deployment, so the capability is removed and the call
  refuses with the reason. Evidence and survivable alternatives:
  [docs/architecture.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/docs/architecture.md#why-there-is-no-screenshot).
- Page-level actions are **Desktop only**.
- Tab ids are unique per session; an ambiguous id is reported and accepted as
  `<sessionId>#<tabId>`.
- Actions are selector-based — no coordinate clicks, uploads or downloads — and
  they target the session currently on screen (`ctx.sidebarRight` semantics).

## Development

No build step and no dependencies: `client.js` is the shipped artifact, written
by hand in the loader's classic-script format.

```sh
npm test        # offline protocol test: stub context + real HTTP + a fake client half
npm run verify  # syntax + protocol test + packaged-tarball check
```

`npm test` needs no DSH running, so it works in CI and on a clean checkout.
Guidelines and the list of invariants that keep this plugin loadable:
[CONTRIBUTING.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/CONTRIBUTING.md).
Releasing:
[RELEASING.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/RELEASING.md).

## License

[MIT](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/LICENSE)
