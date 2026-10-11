# Architecture

Two halves in two processes, joined by four loopback routes. This document
explains why, and records the DSH internals the plugin depends on.

## Why two halves at all

The built-in browser does not live where tools live:

- **Tools and commands run in the Host process.** That is where `ctx.tools` and
  `ctx.commands` exist, and it is the only place a model-facing tool can be
  registered.
- **The browser lives in the Web renderer.** It is a Client plugin
  (`@deepseek-ai/dsh-client-ui-sidebar-browser`) that registers a Sidebar tab
  type, owns a per-tab controller, and (on Desktop) a `<webview>` element inside
  the page's DOM.

DSH gives no supported Host → Client call for a third-party plugin: `ctx.remote.*`
is generated at build time for first-party services, and `host.call()` belongs to
dynamic client halves. So the plugin splits: the Host owns the **operations**, the
Client owns the **presentation**, and they talk over HTTP.

## The bridge

```
agent / user
     │  tool call or /browser
     ▼
┌──────────────────────────── Host process ────────────────────────────┐
│ index.js                                                            │
│   tools: browser_tabs / browser_control / browser_page              │
│   command: /browser                                                 │
│   Pilot: client registry, long-poll waiters, pending calls          │
└───┬─────────────────────────────────────────────────────────────────┘
    │ ①  deliver command to the held poll     ▲ ③ POST /result
    ▼                                         │
┌─────────────────────────── Web renderer ────┴───────────────────────┐
│ client.js                                                           │
│   bridge loop: hello → poll (held ≤10 s) → execute → report          │
│   ctx.sidebarRight  (openTab/close/focus/expanded/fullscreen/…)     │
│   <webview>         (loadURL/goBack/reload/executeJavaScript/…)     │
└─────────────────────────────────────────────────────────────────────┘
```

| Route | Method | Body / query | Answer |
|---|---|---|---|
| `/sidebar-browser-control/hello` | POST | `{clientId?, platform, capabilities, href}` | `{ok, clientId, holdMs}` |
| `/sidebar-browser-control/poll` | GET | `?clientId=…&focus=0\|1` | `{ok, commands:[{id, op, args}]}` |
| `/sidebar-browser-control/result` | POST | `{clientId, id, ok, value?, error?}` | `{ok, settled}` |
| `/sidebar-browser-control/status` | GET | — | `{ok, clients:[…], pendingCalls}` |

## Design decisions

### Long-poll, not SSE

A held `GET /poll` is answered the instant a command is queued, so delivery is
push-like with no timer in either direction. A timeout (10 s) answers with no
commands and the page immediately polls again. Compared with `EventSource` this
costs nothing extra on the wire, needs no reconnection state machine, and cannot
be defeated by a buffering intermediary — the Desktop app serves the page from a
custom scheme whose requests are forwarded to the loopback HTTP server.

### Focus-aware routing

Several windows may hold polls at once. Each poll reports
`document.hasFocus()`, and a command goes to the focused client first, then to the
most recently active one. Without this, a background window could receive the
command and move a panel the user is not looking at.

### Operations that keep the shipped controller authoritative

Layout and tab lifecycle go through `ctx.sidebarRight`
(`openTab`, `close`, `focus`, `active`, `isExpanded`, `toggleExpanded`,
`toggleFullscreen`, `split`, `float`, `dock`, `commandTarget`, `openTabs`,
`mounted`, `tabsIn`). Navigation goes to the carrier itself
(`loadURL`/`goBack`/`goForward`/`reload`), and DSH's own controller observes
those events, so the built-in address bar, back/forward state and restore
checkpoint stay correct instead of diverging from the plugin's idea of the page.

### Session-scoped tab identity

Sidebar layout tab ids are minted per session (`tab1`, `tab2`, …) and
`openTabs.getSnapshot()` is a flat list across sessions, so a bare id is
ambiguous. `browser_tabs` therefore reports `tab_id` plus `session`, and when an
id exists in more than one session it reports and accepts
`<sessionId>#<tabId>`. Every DOM lookup is scoped to the owning session's
`[data-sidebar-right-session]` subtree for the same reason.

### The Host half imports nothing

A profile-installed bundle is resolved from the profile's `node_modules`, not
from inside the DSH installation, so `@deepseek-ai/*` is not importable from it.
`index.js` therefore uses standard-library globals only, and registers tools as
plain objects whose `parameters` is already raw JSON Schema (`defineTool` is what
compiles DSH's author-facing dialect, and it is not available here).

## DSH internals this plugin depends on

Verified against DSH Desktop 0.2.0-rc.2 (Electron 44, Windows x64).

| Dependency | Kind | Failure mode if it changes |
|---|---|---|
| `ctx.sidebarRight` methods listed above | public service | hard failure; tab and layout control stop |
| `ctx.sidebarRight.openTabs` / `mounted` snapshot observables | public service | `browser_tabs` cannot enumerate; everything else still works |
| `sidebar.right.pane.tab` body marker `[data-sidebar-right-tab]` | DOM | page-level actions cannot be targeted per tab |
| `[data-sidebar-right-session]` subtree marker | DOM | session scoping degrades to a global search |
| `[data-dockkit-pane]` / `[data-dockkit-float]` pane ids | DOM (dockkit) | `dock` cannot find the float pane |
| `<webview data-sidebar-browser-frame="webview">` | DOM (Electron carrier) | page-level actions report "no mounted page" |
| Browser tab kind `browser`, `multiple: true` | shipped plugin | `browser_tabs` filters on the kind |
| `ctx.webServer.register({kind:'exact', …})` | public service | plugin cannot load (declared in `inject`) |
| Relative-path `fetch` from the page reaching a Host route | Desktop protocol forwarding + Web same-origin | bridge cannot connect (tools report "not connected") |

The graceful-degradation rule is: **anything that only needs `ctx.sidebarRight`
must keep working when the DOM markers change**, and anything DOM-dependent must
fail with an explicit message rather than a silent no-op.

## Why there is no screenshot

`browser_page { action: "screenshot" }` was implemented with
`webview.capturePage()` and it **crashed the Electron renderer** on the verified
deployment:

```
logs\crash-2026-10-11T13-39-17-759Z-renderer.log
source: renderer / phase: running
Error: Desktop renderer exited: crashed
    at WebContents.<anonymous> (file:///D:/dsh/resources/app.asar/lib/main.js:12067:107)
--- renderer console (error level): (no error-level renderer console output was captured)
```

The whole app process tree (main, GPU, network, renderer, host) restarted. There
was no crashpad report, no Windows application-log entry, and no JavaScript
exception — `render-process-gone` reported `crashed`, not `oom`, so it is a native
crash and cannot be caught in JS. Every other call on the same `<webview>`
(`getURL`, `getTitle`, `isLoading`, `goBack`, `goForward`, `reload`, `loadURL`,
`executeJavaScript`) is fine.

The capability is therefore removed, and the call returns a refusal that names the
reason. If you want screenshots, the survivable designs are main-process ones
(the guest lease in `dsh-desktop-host` plus `webContents.capturePage`, or
`desktopCapturer`); treat them as unverified and test them on a throwaway profile
before shipping, because a renderer crash is not catchable.
