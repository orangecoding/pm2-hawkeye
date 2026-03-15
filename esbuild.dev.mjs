/**
 * esbuild.dev.mjs  Frontend development server with live-reload.
 *
 * Starts an esbuild serve context that:
 *   - Bundles the JSX entry points on every request (instant rebuilds).
 *   - Serves static files from /public.
 *   - Proxies all /api/*, /ws/*, /login, and / requests to the Node backend
 *     (expected on BACKEND_PORT, default 3030) so the developer can run the
 *     backend separately (e.g. with --inspect for debugging).
 *
 * Usage:  node esbuild.dev.mjs
 * Then open http://localhost:3000 in the browser.
 */

import * as esbuild from 'esbuild';
import http from 'node:http';
import { execSync } from 'node:child_process';

const FRONTEND_PORT = parseInt(process.env.DEV_PORT || '3042', 10);
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '3030', 10);
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1';

// Build CSS once at startup (less → css)
try {
  execSync('npx lessc public/styles.less public/styles.css', { stdio: 'inherit' });
} catch {
  console.warn('[dev] Warning: initial CSS build failed  continuing anyway.');
}

// Start esbuild in serve mode for the JS bundles
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

console.log(`[dev] esbuild serving bundles on http://${esbuildHost}:${esbuildPort}`);

/**
 * Proxy helper  forward an HTTP request to a target host:port.
 * Returns a promise that resolves once the proxied response is fully piped.
 */
function proxyRequest(req, res, targetHost, targetPort) {
  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
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
 */
function isBackendRoute(url) {
  return (
    url.startsWith('/api/') ||
    url.startsWith('/ws/') ||
    url === '/login' ||
    url === '/'
  );
}

// Create the main dev-server that sits in front of everything
const server = http.createServer((req, res) => {
  if (isBackendRoute(req.url)) {
    // Forward to the Node backend
    proxyRequest(req, res, BACKEND_HOST, BACKEND_PORT);
  } else {
    // Forward to esbuild's static server (JS bundles + public assets)
    proxyRequest(req, res, esbuildHost === '0.0.0.0' ? '127.0.0.1' : esbuildHost, esbuildPort);
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
  console.log('[dev] Start the backend separately:  node lib/server.js');
});
