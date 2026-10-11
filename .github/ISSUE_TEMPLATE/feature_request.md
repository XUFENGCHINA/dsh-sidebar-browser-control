---
name: Feature request
about: Suggest a capability for driving the built-in browser
title: ''
labels: enhancement
---

## What should the agent be able to do

<!-- The user-facing ability, e.g. "read a specific table cell" or "handle a JS alert". -->

## Which surface

- [ ] `browser_tabs`
- [ ] `browser_control` (new action)
- [ ] `browser_page` (new action)
- [ ] `/browser` subcommand
- [ ] other:

## Constraints worth knowing

<!--
- Page-level actions must be Desktop-only: the Web profile's iframe is sandboxed
  and cross-origin, so it cannot be read.
- `capturePage()` and other guest-side native capture are off the table: they
  crashed the renderer (see docs/architecture.md).
- A new capability should degrade with an explicit error, never silently.
-->
