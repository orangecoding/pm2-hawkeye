# CLAUDE.md - pm2-hawkeye

## Project Overview

pm2-hawkeye is a modern, real-time web dashboard for PM2 processes. It provides live process monitoring (CPU, memory, uptime, restart count), real-time log streaming (stdout + stderr merged and sorted chronologically), one-click process restart with confirmation, and support for triggering PM2 custom actions (`axm_actions`). All real-time data (process list, live stats, log lines, deploy progress) flows over one WebSocket, no SSE; stored history (metrics, host metrics, deployments) is refreshed over HTTP on a timer.

The app must run on the same server as the PM2 daemon. It communicates with PM2 via its local API. Remote connections are not supported.

---

## Tech Stack

| Layer      | Technology                                     |
|------------|------------------------------------------------|
| Runtime    | Node.js                                        |
| Frontend   | React 19, bundled with esbuild                 |
| Transport  | WebSockets (ws library)                        |
| Auth       | scrypt password hashing, CSRF tokens, sessions |
| Testing    | Mocha                                          |
| Linting    | ESLint                                         |
| Formatting | Prettier                                       |
| Package mgr| Yarn                                           |

---

## Common Commands

```bash
# Install dependencies
yarn install

# Build frontend and start the server
npm start

# Build frontend assets only
npm run build

# Start backend with Node.js debugger (dev mode)
node --inspect lib/transport/server.js

# Start esbuild dev server (HMR, port 3042, proxies to backend on 3030)
npm run dev

# Run test suite
npm test

# Lint
npm run lint

# Format (write)
npm run format

# Format (check only)
npm run format:check
```

---

## Development Setup

The dev environment uses a two-process setup:

1. **Backend** runs on port `3030` via `node --inspect lib/transport/server.js`.
2. **Frontend dev server** runs on port `3042` via `npm run dev`.

The esbuild dev server (`esbuild.dev.mjs`) instantly rebuilds JSX/JS bundles on every change, serves source maps, and proxies `/api/*`, `/ws/*`, and HTML routes through to the backend on port 3030.

During development, always open `http://localhost:3042`.

---

## Configuration (`.env`)

Copy `.env.example` to `.env` and populate all values before starting the server.

| Variable                | Default       | Description                                     |
|-------------------------|---------------|-------------------------------------------------|
| `HOST`                  | `0.0.0.0`     | Bind address                                    |
| `PORT`                  | `3030`        | HTTP and WebSocket port                         |
| `AUTH_USERNAME`         | `admin`       | Login username (case-insensitive)               |
| `AUTH_PASSWORD_SALT`    | -             | Hex-encoded salt                                |
| `AUTH_PASSWORD_HASH`    | -             | Hex-encoded scrypt hash (64 bytes)              |
| `SESSION_TTL_MS`        | `28800000`    | Session lifetime in ms (default: 8 h)           |
| `COOKIE_SECURE`         | `auto`        | `auto` / `always` / `never`                     |
| `TRUST_PROXY`           | `0`           | Set to `1` when running behind a reverse proxy  |
| `MAX_LOG_BYTES_PER_FILE`| `5242880`     | Maximum bytes read per PM2 log file             |

To generate a password hash and salt:

```bash
node -e "
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('YOUR_PASSWORD', Buffer.from(salt,'hex'), 64).toString('hex');
  console.log('AUTH_PASSWORD_SALT=' + salt);
  console.log('AUTH_PASSWORD_HASH=' + hash);
"
```

---

## Running in Production

The recommended way is to run pm2-hawkeye as a PM2 process itself:

```bash
npm run build
pm2 start lib/transport/server.js --name pm2-hawkeye
pm2 save
```

This ensures the dashboard is supervised and auto-restarted, and is included in `pm2 startup`.

---

## PM2 Requirements

PM2 7 or newer must be installed globally and the running daemon must be on it too (`pm2 update` after upgrading). The server refuses to start otherwise.

All managed PM2 processes should be started with the `--time` flag so that log lines include timestamps. pm2-hawkeye merges stdout and stderr and sorts lines chronologically - without timestamps, this sort is undefined and error lines will always appear after info lines.

```bash
pm2 start app.js --name my-app --time
```

Or via `ecosystem.config.js`:

```js
module.exports = {
  apps: [{ name: 'my-app', script: 'app.js', time: true }]
};
```

---

## Code Style

- JavaScript only (no TypeScript).
- ESLint for linting, Prettier for formatting, both are enforced. Run `npm run lint` and `npm run format:check` before committing.
- Frontend is React with JSX; no class components, use functional components and hooks.
- Backend uses ESM as configured in `package.json`, check before adding new files.
- Single quotes, do not use double quotes
- All comments and documentation must be written in English.
- All code changes must be documented using jsdoc
- If something is too complicated to do manually, use a lib, but make sure it is still maintained
- If code was changed, check if documentation or readme must be adapted as well
- Never use em dash
---

## Testing

Tests live in `test/` and are run with Mocha (configured in `.mocharc.yml`).

```bash
npm test
```

When adding new backend functionality, add corresponding tests. The CI pipeline runs the test suite on every push via GitHub Actions (`.github/workflows/test.yml`).

---

## Architecture Notes

- The WebSocket connection is the single channel for all real-time data: the process list, live stats of the selected process (`details`), its log lines and deploy progress all flow through it. Process-scoped messages carry the `processId` the client selected, so the client drops messages still in flight for a previous selection. Action results come back in the HTTP response of the trigger request.
- Before anything else starts, `lib/service/pm2Requirement.js` runs `pm2 --version` and asks the daemon for its version; startup aborts with instructions unless both are PM2 >= 7 (skipped in tests). The `pm2 --version` call comes first so a missing daemon is started by the installed PM2 rather than by the client bundled in node_modules. The backend then connects to the local PM2 daemon using the PM2 programmatic API. All RPC calls share one connection (`withConnection` in `lib/service/pm2Service.js`), reset only on transport errors. If no daemon is running, `pm2.connect` starts one for the current user, so Hawkeye must run as the user that owns the PM2 processes.
- Live log lines arrive through the PM2 log bus (`lib/service/logBus.js`). For a process that is not monitored, the WS first sends a snapshot read from its PM2 log files, up to `MAX_LOG_BYTES_PER_FILE` bytes per file, with stdout and stderr merged and sorted by timestamp prefix. Monitored processes load their history from SQLite over HTTP instead.
- PM2 custom actions (`axm_actions`) are exposed dynamically based on what each running process registers with PM2.
- Application metrics come from `pm2_env.axm_monitor`, where the PM2 daemon keeps the latest value of every metric a process reports through tx2 or @pm2/io (PM2 injects @pm2/io into every Node process, so heap and event loop metrics are always there). `extractCustomMetrics` in `lib/service/pm2Service.js` turns that into `{ name, value, unit }` rows: live values ride on the WS `details` push, and `lib/service/metricsScheduler.js` stores them for monitored processes in `custom_metrics_history` next to CPU/memory. `GET /api/processes/:id/metrics` returns them under `custom`.
- The Manage tab can set the log level of a running process. Node exposes no
  log level from outside a process, so `lib/service/logLevelService.js` sends a
  `hawkeye:log-level` IPC message through `pm2.sendDataToProcessId` and waits up
  to 1.5 s for a `hawkeye:log-level:ack` answer, which arrives on the log bus
  that `lib/service/logBus.js` already has open. PM2 names the bus event after
  the packet's `type` and strips `topic` from anything a process sends back, so
  the answer travels as its own bus event. Hawkeye stores no level: every read
  asks the process again, so after a restart the UI shows whatever level the
  application booted with. Applications opt in with a ten-line
  `process.on('message')` listener, see the README.
- A redeploy updates the clone with `git remote set-url` (the stored repo URL), `git fetch --depth 1 origin <branch>` and `git checkout -B <branch> FETCH_HEAD`, so edits to the repo URL or branch take effect and local commits are dropped; untracked files such as `.env` stay. A redeploy that finds tracked local changes in the deploy directory pauses on `waitForConfirmation` until the user discards or cancels. A deployment with `discard_local_changes` set, and every watcher-triggered deploy, skips that question and resets the working copy directly.
- Deployments can opt into branch watching. `lib/service/branchWatcher.js` ticks once a minute, polls `git ls-remote` for every deployment whose own interval has elapsed, and runs the normal redeploy pipeline when the branch head differs from both the local `HEAD` and the last SHA it already deployed. Watcher-triggered deploys pass `autoConfirm` so `runDeploy` discards local changes instead of waiting for a confirmation nobody will give, and the outcome is sent through the alerting reporters.

### Frontend structure

The UI follows one path: **pick an object, then act on it.**

```
App.jsx                 shell, all state and API calls, tab routing
├── HostMetrics.jsx     host CPU/RAM/disk readout in the top bar
├── ProcessList.jsx     sidebar, grouped running / not running / not deployed
├── ProcessHeader.jsx   name, status, live stat strip, Restart + Stop/Start
│   └── (tabs)
├── LogStream.jsx       Logs tab
├── MetricsPanel.jsx    Metrics tab - process, application (tx2) and host charts
├── ManagePanel.jsx     Manage tab - monitoring, alerts, log level, actions, deploy, delete
│   └── Actions.jsx     PM2 axm_actions, one row per action
├── Settings.jsx        overlay, General + Alerting pages
├── DeployModal.jsx     single-scroll deploy form and live progress view
├── ConfirmButton.jsx   the app's only confirmation idiom
├── KeyValueList.jsx    key/value row editor (env vars, webhook headers and body)
└── Icon.jsx            re-exports Phosphor icons plus shared defaults
```

Conventions worth keeping:

- **Every per-process function belongs to exactly one tab.** Do not add a
  second entry point for something that already has a home.
- **Confirmations go through `ConfirmButton`.** No `window.confirm`, no
  bespoke inline yes/no markup. The only exceptions are prompts a button
  cannot open: questions the app raises on its own (unsaved Settings changes
  on close, the server's local-changes question during a deploy) and the
  custom-action form in `Actions.jsx`, which also collects parameters.
- **Icons come from `Icon.jsx` only.** One family, one weight, set through
  `IconContext` in `App.jsx`. Never hand-roll SVG paths.
- **Styling uses the tokens in `src/styles/variables.less`.** Two radii
  (`--r-1` controls, `--r-2` surfaces), a 4px spacing scale (`--s-*`), and one
  accent. Status colours are semantic, never decorative.
- **Numbers use `--font-mono` with `tabular-nums`** so metric columns line up
  and values do not jitter as they tick.
