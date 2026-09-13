/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Runtime guard.
 *
 * PM2-Hawkeye is a Node.js application. It relies on native N-API addons
 * (better-sqlite3) and on PM2's programmatic API, neither of which is
 * currently supported by alternative runtimes such as Bun or Deno. Bun in
 * particular replaces `node` with itself inside package.json scripts, so
 * `bun start` silently runs the server on Bun and crashes with a
 * segmentation fault (SIGSEGV) while loading the SQLite addon.
 *
 * This module is imported as the very first dependency of the entry point so
 * that the check runs before any native module is loaded. Instead of a
 * segfault, the user gets an actionable error message.
 *
 * Set `ALLOW_UNSUPPORTED_RUNTIME=1` to bypass the guard (unsupported).
 */

/** Minimum supported major version of Node.js, kept in sync with package.json `engines`. */
export const MIN_NODE_MAJOR = 22;

/**
 * Detect the JavaScript runtime the process is executing in.
 *
 * @param {object} [globalObject] - Global object to inspect (injectable for tests).
 * @returns {{ name: 'bun'|'deno'|'node', version: string }} Runtime name and version.
 */
export function detectRuntime(globalObject = globalThis) {
  const bunVersion = globalObject?.Bun?.version;
  if (typeof bunVersion === 'string') {
    return { name: 'bun', version: bunVersion };
  }

  const denoVersion = globalObject?.Deno?.version?.deno;
  if (typeof denoVersion === 'string') {
    return { name: 'deno', version: denoVersion };
  }

  return { name: 'node', version: globalObject?.process?.versions?.node || '' };
}

/**
 * Build the error message for an unsupported runtime, or `null` when the
 * runtime is supported.
 *
 * @param {{ name: string, version: string }} runtime - Result of {@link detectRuntime}.
 * @returns {string|null} Human readable error message, or `null` if all good.
 */
export function unsupportedRuntimeMessage(runtime) {
  if (runtime.name === 'node') {
    return null;
  }

  const label = runtime.name === 'bun' ? 'Bun' : runtime.name === 'deno' ? 'Deno' : runtime.name;
  const version = runtime.version ? ` ${runtime.version}` : '';

  return [
    `PM2-Hawkeye detected an unsupported runtime: ${label}${version}.`,
    `Only Node.js >= ${MIN_NODE_MAJOR} is supported, because PM2-Hawkeye loads native N-API addons`,
    '(better-sqlite3) that crash on other runtimes with a segmentation fault.',
    '',
    'Note that "bun run" and "bun start" replace "node" inside package.json scripts with Bun itself,',
    'so running "bun start" does not start the server on Node.js. Use npm instead:',
    '',
    '  npm install',
    '  npm start',
    '',
    'Or build with any package manager and start the server explicitly with Node.js:',
    '',
    '  npm run build',
    '  node lib/transport/server.js',
    '',
    'Set ALLOW_UNSUPPORTED_RUNTIME=1 to skip this check (unsupported, may crash).',
  ].join('\n');
}

/**
 * Abort startup when the current runtime is not supported.
 *
 * @param {object} [options] - Options.
 * @param {object} [options.globalObject] - Global object to inspect (injectable for tests).
 * @param {NodeJS.ProcessEnv} [options.env] - Environment variables to read.
 * @param {(code: number) => void} [options.exit] - Exit function (injectable for tests).
 * @param {(message: string) => void} [options.onError] - Error reporter (injectable for tests).
 * @returns {boolean} `true` when the runtime is supported (or the check was bypassed).
 */
export function assertSupportedRuntime({
  globalObject = globalThis,
  env = process.env,
  exit = process.exit,
  onError = (message) => console.error(message),
} = {}) {
  if (env.ALLOW_UNSUPPORTED_RUNTIME === '1') {
    return true;
  }

  const message = unsupportedRuntimeMessage(detectRuntime(globalObject));
  if (!message) {
    return true;
  }

  onError(message);
  exit(1);
  return false;
}

// Run the check on import so that it happens before any native addon is
// loaded. Tests import this module to exercise the exported helpers directly.
if (process.env.NODE_ENV !== 'test') {
  assertSupportedRuntime();
}
