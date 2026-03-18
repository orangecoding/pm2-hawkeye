# CLAUDE.md - pm2-manager

## Project Overview

pm2-manager is a modern, real-time web dashboard for PM2 processes. It provides live process monitoring (CPU, memory, uptime, restart count), real-time log streaming (stdout + stderr merged and sorted chronologically), one-click process restart with confirmation, and support for triggering PM2 custom actions (`axm_actions`). The entire transport layer is WebSocket-based, no polling, no SSE.

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

The recommended way is to run pm2-manager as a PM2 process itself:

```bash
npm run build
pm2 start lib/transport/server.js --name pm2-manager
pm2 save
```

This ensures the dashboard is supervised and auto-restarted, and is included in `pm2 startup`.

---

## PM2 Requirements

All managed PM2 processes should be started with the `--time` flag so that log lines include timestamps. pm2-manager merges stdout and stderr and sorts lines chronologically - without timestamps, this sort is undefined and error lines will always appear after info lines.

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

- The WebSocket connection is the single channel for all real-time data: process list updates, log lines, and action results all flow through it.
- The backend connects to the local PM2 daemon on startup using the PM2 programmatic API. If PM2 is not running, the server will fail to initialize.
- Log streaming is implemented by tailing PM2 log files directly and reading up to `MAX_LOG_BYTES_PER_FILE` bytes from each file. Logs from stdout and stderr are merged and sorted by timestamp prefix.
- PM2 custom actions (`axm_actions`) are exposed dynamically based on what each running process registers with PM2.
