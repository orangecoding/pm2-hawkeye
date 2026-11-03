---
title: "Alerta topics use a hawkeye- prefix, not hawkeye:"
author: Christian
date: 2026-11-03
branch: master
cost: { minutes: 1, tokens: 67525 }
id: l-9369a92d
scope: repo
status: active
src: agent
touches:
  - lib/service/reporters/alerta.js
  - test/alertaReporter.test.js
  - src/components/settings/AlertingSettings.jsx
---

## Decided
Every Alerta topic Hawkeye sends is `hawkeye-<process name>`, so Hawkeye's entries stand out in an Alerta inbox shared with other senders.

## Tried and ruled out
`hawkeye:<process name>` was the original wish. Alerta validates topics against `^[A-Za-z0-9_-]{1,64}$` (its `SLUG` schema, shared with action ids), so a colon gets HTTP 400. Allowing `:` would mean a schema change in the alerta repo; the user picked the dash instead.

## Watch out
The prefix eats 8 of the 64 characters, so the process name part is cut at 56.

In the code: `toAlertaTopic` and `TOPIC_PREFIX` in lib/service/reporters/alerta.js; alerta's rule in ~/dev/private/alerta/lib/notifications/schemas.js.
