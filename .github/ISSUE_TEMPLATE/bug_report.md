---
name: Bug report
about: Something in the built-in browser control does not work
title: ''
labels: bug
---

<!--
Before filing: if a tool returned an explicit error message, paste it — the
messages are written to be diagnostic. `browser_tabs` output (platform,
page_control, panel_open) answers most environment questions up front.
-->

## What happened

<!-- What you asked for, and what happened instead. -->

## Reproduction

```
# the tool call or /browser line, and the result you got back
```

## Environment

| | |
|---|---|
| DSH version / Desktop app version | <!-- e.g. DSH Desktop 0.2.0-rc.2 --> |
| Platform | <!-- Desktop app or Web profile --> |
| OS + arch | <!-- e.g. Windows 11 x64 / macOS 15 arm64 --> |
| Plugin version | <!-- e.g. 0.1.0 --> |

## Diagnostics

```
# output of: browser_tabs
# optionally, if you can read it:
#   GET http://127.0.0.1:<port>/sidebar-browser-control/status
```

## Anything else

<!-- Console output from the DSH page (DevTools) is very useful for bridge issues:
     "[sidebar-browser-control] ..." lines come from this plugin. -->
