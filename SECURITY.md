# Security policy

## Threat model

This plugin deliberately grants a **model** the ability to drive a real browser
surface:

- On Desktop, `browser_page eval` runs arbitrary JavaScript inside the built-in
  browser tab's `<webview>`, in the page's own origin, with that page's cookies
  and storage. If you are logged into something in that tab, the agent can act
  as you there, and `browser_page text` can read whatever is on screen.
- `browser_control external` hands a URL to your default browser.
- `browser_page type`/`click` can submit forms.

Everything an agent does through these tools is visible in the session log as a
tool call with its arguments, so the usual rule applies: **do not run an agent
with these tools against a session you would not let read your screen.**

## Host surface

The Host half opens four loopback routes and nothing else:

| Route | Method | Purpose |
|---|---|---|
| `/sidebar-browser-control/hello` | POST | page announces platform and capabilities |
| `/sidebar-browser-control/poll` | GET | long-poll, delivers commands to the page |
| `/sidebar-browser-control/result` | POST | page settles one command |
| `/sidebar-browser-control/status` | GET | diagnostics (client list, pending calls) |

Hardening that is in place:

- Requests are admitted only when `Sec-Fetch-Site` is `same-origin`/`none` **and**
  `Origin` is absent, `dsh-app://app`, or a loopback http(s) origin. A random web
  page cannot CSRF the panel, and a cross-site `fetch` is refused with 403.
- Request bodies are capped (2 MiB); the poll is held for at most 10 s.
- Commands can only be *originated* by this plugin's own tools and command —
  there is no route that accepts arbitrary commands from a caller.
- No credentials, tokens or file paths are read or written by the plugin.

Residual risk, by design:

- Any local process that can reach the loopback web server may interact with the
  routes. That is the same trust boundary as every other DSH loopback route; the
  plugin does not add authentication on top of it.
- The tools act on the session currently on screen, not necessarily the session
  that called them.

## Reporting a vulnerability

Open a private security advisory on the repository
(`Security` → `Report a vulnerability`), or email the maintainer listed in
`package.json`. Please include the DSH version (`dsh --version`, or the Desktop
app version), the platform (Desktop or Web), and the smallest reproduction you
have. Please do not open a public issue for a vulnerability before a fix is
available.
