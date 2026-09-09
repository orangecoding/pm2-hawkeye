/**
 * esbuild.dev.mjs  Frontend development server with live-reload.
 *
 * Starts an esbuild serve context that:
 *   - Bundles the JSX entry points on every request (instant rebuilds).
 *   - Watches src/styles/ and public/styles.less for changes, recompiling CSS
 *     via the less Node API and notifying connected browsers to reload.
 *   - Watches src/ for JSX/JS changes and notifies browsers to reload.
 *   - Serves static files from /public.
 *   - Proxies all /api/*, /ws/*, /login, and / requests to the Node backend
 *     (expected on BACKEND_PORT, default 3030) so the developer can run the
 *     backend separately (e.g. with --inspect for debugging).
 *   - Injects a tiny SSE-based live-reload script into every HTML response.
 *
 * Usage:  node esbuild.dev.mjs
 * Then open http://localhost:3042 in the browser.
 */

import * as esbuild from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import less from 'less';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FRONTEND_PORT = parseInt(process.env.DEV_PORT || '3042', 10);
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '3030', 10);
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1';

// ── Live-reload SSE hub ───────────────────────────────────────────────────────

/** All SSE response streams currently connected to /__dev_reload. */
const sseClients = new Set();

/** Send a reload event to every connected browser tab. */
function sendReload() {
  for (const res of sseClients) {
    try {
      res.write('data: reload\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}

// ── LESS compilation ──────────────────────────────────────────────────────────

const STYLES_ENTRY = path.join(__dirname, 'public', 'styles.less');
const STYLES_OUT = path.join(__dirname, 'public', 'styles.css');
const STYLES_DIR = path.join(__dirname, 'src', 'styles');

/** Compile public/styles.less -> public/styles.css and trigger a browser reload. */
async function compileLess() {
  try {
    const src = fs.readFileSync(STYLES_ENTRY, 'utf8');
    const result = await less.render(src, { filename: STYLES_ENTRY });
    fs.writeFileSync(STYLES_OUT, result.css);
    console.log('[dev] CSS rebuilt');
    sendReload();
  } catch (err) {
    console.error('[dev] CSS build error:', err.message);
  }
}

// Initial CSS build
await compileLess();

// Watch all .less source files and recompile on change
fs.watch(STYLES_DIR, { recursive: true }, (_event, filename) => {
  if (filename && filename.endsWith('.less')) {
    compileLess();
  }
});

// Also watch the entry point itself (public/styles.less)
fs.watch(STYLES_ENTRY, () => compileLess());

// ── JS/JSX source watcher ─────────────────────────────────────────────────────

// esbuild rebuilds JS lazily on the next request when using ctx.serve().
// Watching src/ and sending a reload tells the browser to fetch fresh bundles.
fs.watch(path.join(__dirname, 'src'), { recursive: true }, (_event, filename) => {
  if (filename && (filename.endsWith('.js') || filename.endsWith('.jsx'))) {
    sendReload();
  }
});

// ── esbuild serve ─────────────────────────────────────────────────────────────

const ctx = await esbuild.context({
  entryPoints: {
    app: 'src/main.jsx',
    login: 'src/login.jsx',
  },
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outdir: 'public',
  sourcemap: true,
});

// esbuild's built-in serve only serves the output directory
const { host: esbuildHost, port: esbuildPort } = await ctx.serve({
  servedir: 'public',
});

const esbuildHostResolved = !esbuildHost || esbuildHost === '0.0.0.0' ? '127.0.0.1' : esbuildHost;
console.log(`[dev] esbuild serving bundles on http://${esbuildHostResolved}:${esbuildPort}`);

// ── Live-reload injection ─────────────────────────────────────────────────────

/**
 * Tiny inline script injected before </body> of every HTML page.
 * Opens an EventSource on /__dev_reload and calls location.reload() when the
 * server signals that a JS or CSS file has been rebuilt.
 */
const LIVE_RELOAD_SCRIPT = `<script>
(function(){
  var es = new EventSource('/__dev_reload');
  es.onmessage = function(e){ if (e.data === 'reload') location.reload(); };
  es.onerror   = function(){ setTimeout(function(){ location.reload(); }, 1500); };
})();
</script>`;

// ── Proxy helpers ─────────────────────────────────────────────────────────────

/**
 * Forward an HTTP request to targetHost:targetPort.
 * When injectReload is true and the response is HTML, the live-reload script
 * is injected before the closing </body> tag.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {boolean} injectReload
 */
function proxyRequest(req, res, targetHost, targetPort, injectReload) {
  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      const isHtml = injectReload && contentType.includes('text/html');

      if (!isHtml) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
        return;
      }

      // Buffer the full HTML body so we can insert the script tag
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        body = body.includes('</body>')
          ? body.replace('</body>', LIVE_RELOAD_SCRIPT + '</body>')
          : body + LIVE_RELOAD_SCRIPT;

        const headers = { ...proxyRes.headers };
        delete headers['content-length']; // length changed after injection
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    },
  );

  proxyReq.on('error', (err) => {
    console.error(`[dev] Proxy error → ${targetHost}:${targetPort}${req.url}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Backend unavailable. Make sure the Node server is running on port ' + targetPort);
  });

  req.pipe(proxyReq, { end: true });
}

/**
 * Determine whether a request should be forwarded to the Node backend
 * (API calls, WebSocket upgrades, HTML pages served by Express).
 *
 * @param {string} url
 * @returns {boolean}
 */
function isBackendRoute(url) {
  return url.startsWith('/api/') || url.startsWith('/ws/') || url === '/login' || url === '/';
}

// ── Dev HTTP server ───────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // SSE endpoint consumed by the injected live-reload script
  if (req.url === '/__dev_reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':\n\n'); // initial keep-alive comment
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (isBackendRoute(req.url)) {
    proxyRequest(req, res, BACKEND_HOST, BACKEND_PORT, true);
  } else {
    proxyRequest(req, res, esbuildHostResolved, esbuildPort, false);
  }
});

// Proxy WebSocket upgrades to the backend
server.on('upgrade', (req, socket, head) => {
  const proxyReq = http.request({
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 ${proxyRes.statusCode || 101} ${proxyRes.statusMessage || 'Switching Protocols'}\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    if (proxyHead.length) {
      socket.write(proxyHead);
    }
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('error', (err) => {
    console.error('[dev] WebSocket proxy error:', err.message);
    socket.destroy();
  });

  proxyReq.end();
});

server.listen(FRONTEND_PORT, () => {
  console.log(`[dev] Dev server ready → http://localhost:${FRONTEND_PORT}`);
  console.log(`[dev] Proxying API/WS to backend → http://${BACKEND_HOST}:${BACKEND_PORT}`);
  console.log('[dev] Start the backend separately:  node lib/transport/server.js');
  console.log('[dev] Live-reload active: JS and CSS changes auto-refresh the browser');
});
