<p align="center">
  <h1 align="center">🖥️ PM2 Manager</h1>
  <p align="center"><strong>A modern, real-time web dashboard for your PM2 processes.</strong></p>
  <p align="center">Monitor, restart, and tail logs - all from a sleek dark-mode UI.</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen?logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" />
  <img src="https://img.shields.io/badge/frontend-React%2019-61dafb?logo=react" alt="React" />
  <img src="https://img.shields.io/badge/transport-WebSockets-blueviolet" alt="WebSockets" />
  <img src="https://github.com/orangecoding/pm2-manager/actions/workflows/test.yml/badge.svg" alt="Tests" />
</p>

---

## ✨ Features

- 📊 **Live process overview** - CPU, memory, uptime, and restart count at a glance
- 📜 **Real-time log streaming** - stdout & stderr tailed directly in the browser
- 🔄 **One-click restart** - restart any process with an inline confirmation
- ⚡ **PM2 custom actions** - trigger any `axm_actions` your processes expose
- 🔒 **Secure by default** - scrypt password hashing, CSRF protection, rate limiting, CSP headers
- 🌐 **100 % WebSocket-based** - no polling, no SSE; instant updates over a single connection
- 🎨 **Dark-mode UI** - clean, responsive dashboard that works on desktop and mobile

---

## 📸 Screenshots

| Login                                                  | Main View                                              |
|--------------------------------------------------------|--------------------------------------------------------|
| ![Screenshot showing the login page](docs/screen1.png) | ![Screenshot, showing the main view](docs/screen2.png) |



## ⚠️ Important: Enable Timestamps for Log Sorting

> [!WARNING]
> **PM2 Manager sorts log lines chronologically across stdout and stderr.** This only works correctly when PM2 prefixes each log line with a timestamp.
>
> Always start your processes with the `--time` flag:
> ```bash
> pm2 start app.js --name my-app --time
> ```
> Or add it to your `ecosystem.config.js`:
> ```js
> module.exports = {
>   apps: [{ name: 'my-app', script: 'app.js', time: true }]
> };
> ```
> Without `--time`, PM2 writes no timestamp to log lines and log sorting across multiple log files (stdout + stderr) will not work — error lines will always appear after info lines.

---

## ⚠️ Important: Same-Server Requirement

> [!CAUTION]
> **PM2 Manager must run on the same server where your PM2 daemon is running.**
> It communicates directly with PM2 via its local API - there is no remote connection support.
>
> The recommended way to run PM2 Manager is **as a PM2 process itself**:
> ```bash
> pm2 start lib/transport/server.js --name pm2-manager
> pm2 save
> ```
> This way PM2 Manager is supervised, auto-restarted, and included in `pm2 startup`.

---


## 🚀 Quick Start

### Prerequisites

- **Node.js 22** or higher
- **PM2** installed globally (`npm i -g pm2`)
- At least one PM2 process running

### 1. Clone & install

```bash
git clone https://github.com/orangecoding/pm2-manager.git
cd pm2-manager
npm install
```

### 2. Configure credentials

Copy the example `.env` and generate a secure password hash:

```bash
cp .env.example .env   # or edit .env directly
```

Generate your password hash & salt (replace `YOUR_PASSWORD`):

```bash
node -e "\
  const crypto = require('crypto');\
  const salt = crypto.randomBytes(16).toString('hex');\
  const hash = crypto.scryptSync('YOUR_PASSWORD', Buffer.from(salt,'hex'), 64).toString('hex');\
  console.log('AUTH_PASSWORD_SALT=' + salt);\
  console.log('AUTH_PASSWORD_HASH=' + hash);"
```

Paste the output into your `.env` file.

### 3. Build & run

```bash
npm start
```

This builds the frontend assets and starts the server.  
👉 Open **http://localhost:3030** in your browser.

### 4. Run as a PM2 process (recommended)

```bash
npm run build                          # build frontend once
pm2 start lib/transport/server.js --name pm2-manager
pm2 save
```

---

## ⚙️ Configuration

All settings live in a single `.env` file in the project root:

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3030` | HTTP & WebSocket port |
| `AUTH_USERNAME` | `admin` | Login username (case-insensitive) |
| `AUTH_PASSWORD_SALT` | - | Hex-encoded salt (see above) |
| `AUTH_PASSWORD_HASH` | - | Hex-encoded scrypt hash (64 bytes) |
| `SESSION_TTL_MS` | `28800000` | Session lifetime (default: 8 h) |
| `COOKIE_SECURE` | `auto` | `auto` / `always` / `never` |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy |
| `MAX_LOG_BYTES_PER_FILE` | `5242880` | Max bytes read per PM2 log file |

---

## 🛠️ Development

PM2 Manager ships with a dedicated dev setup that gives you **hot module replacement (HMR)** for the frontend while letting you debug the backend independently.

### Start the backend (with debugger)

```bash
node --inspect lib/transport/server.js
```

This starts the Node.js backend on port **3030** with the V8 inspector enabled.

### Start the frontend dev server

In a second terminal:

```bash
npm run dev
```

This spins up an **esbuild-powered dev server** on port **3042** that:

- ⚡ **Instantly rebuilds** JSX/JS bundles on every change
- 🗺️ Serves **source maps** for easy debugging
- 🔀 **Proxies** all `/api/*`, `/ws/*`, and HTML routes to the backend on port 3030

👉 Open **http://localhost:3042** and start developing.

### Run tests

```bash
npm test
```

### Lint & format

```bash
npm run lint          # ESLint
npm run format        # Prettier (write)
npm run format:check  # Prettier (check only)
```
---

## 🔒 Security

- **CSRF tokens** - one-time-use tokens rotated after every state-changing request
- **Rate limiting** - exponential backoff lockout on failed login attempts
- **CSP headers** - strict Content-Security-Policy including `ws:`/`wss:` for WebSockets
- **Timing-attack mitigation** - constant-time credential comparison with minimum response delay
- **Secure cookies** - `HttpOnly`, `SameSite=Strict`, optional `Secure` flag

---

## 📝 License

[Apache-2.0](LICENSE) - © Christian Kellner
