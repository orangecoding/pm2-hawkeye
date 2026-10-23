/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * PM2 requirement check.
 *
 * PM2-Hawkeye talks to the PM2 daemon through the PM2 7 client it ships with.
 * Startup is aborted unless PM2 is installed on the server in version 7 or
 * newer and the running daemon is on that version too. The daemon is checked
 * separately because upgrading the global package leaves the old daemon
 * running until `pm2 update` replaces it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDaemonVersion } from './pm2Service.js';

const execFileAsync = promisify(execFile);

/** Minimum supported major version of PM2, for the installed CLI and the daemon. */
export const MIN_PM2_MAJOR = 7;

/** Upper bound for `pm2 --version`, which may have to start the daemon first. */
const CLI_TIMEOUT_MS = 15_000;

/**
 * Pull the version out of `pm2 --version` output.
 *
 * The CLI can print an "In-memory PM2 is out-of-date" notice around the
 * version, so the last line that looks like a version wins.
 *
 * @param {string} output - Raw stdout of `pm2 --version`.
 * @returns {string|null} The version, e.g. `7.1.0`, or null when none is found.
 */
export function parsePm2Version(output) {
  const versions = String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\d+\.\d+\S*$/.test(line));
  return versions.at(-1) ?? null;
}

/**
 * Major version of a PM2 version string.
 *
 * @param {string} version
 * @returns {number} The major version, or NaN when it cannot be read.
 */
function majorOf(version) {
  return Number.parseInt(String(version), 10);
}

/**
 * Read the version of the PM2 installed on this machine through its CLI.
 *
 * @returns {Promise<string|null>} The version, or null when `pm2` is not
 *   installed or not on the PATH.
 * @throws {Error} When `pm2` exists but fails or prints no version.
 */
export async function readInstalledPm2Version() {
  // A .cmd shim needs a shell on Windows since Node 20; the arguments are fixed.
  const isWindows = process.platform === 'win32';
  let stdout;
  try {
    ({ stdout } = await execFileAsync(isWindows ? 'pm2.cmd' : 'pm2', ['--version'], {
      timeout: CLI_TIMEOUT_MS,
      shell: isWindows,
    }));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Running "pm2 --version" failed: ${err.message}`, { cause: err });
  }
  const version = parsePm2Version(stdout);
  if (!version) throw new Error(`"pm2 --version" printed no version: ${stdout.trim().slice(0, 200)}`);
  return version;
}

/**
 * Build the error message for the found PM2 versions, or `null` when they meet
 * the requirement.
 *
 * @param {{ cliVersion: string|null, daemonVersion?: string|null }} versions -
 *   `daemonVersion` is only looked at once the installed version is fine.
 * @returns {string|null}
 */
export function pm2RequirementMessage({ cliVersion, daemonVersion = null }) {
  const upgrade = [
    '',
    'Install or upgrade it, then restart the running daemon with the new version:',
    '',
    '  npm install -g pm2@latest',
    '  pm2 update',
  ];

  if (!cliVersion) {
    return [
      `PM2-Hawkeye requires PM2 >= ${MIN_PM2_MAJOR}, but no "pm2" command was found on the PATH.`,
      ...upgrade,
    ].join('\n');
  }
  if (!(majorOf(cliVersion) >= MIN_PM2_MAJOR)) {
    return [`PM2-Hawkeye requires PM2 >= ${MIN_PM2_MAJOR}, but PM2 ${cliVersion} is installed.`, ...upgrade].join('\n');
  }
  if (daemonVersion && !(majorOf(daemonVersion) >= MIN_PM2_MAJOR)) {
    return [
      `PM2 ${cliVersion} is installed, but the running PM2 daemon is still ${daemonVersion}.`,
      `PM2-Hawkeye requires a daemon >= ${MIN_PM2_MAJOR}. Replace it with the installed version:`,
      '',
      '  pm2 update',
    ].join('\n');
  }
  return null;
}

/**
 * Check that PM2 is installed in a supported version and that the running
 * daemon matches.
 *
 * The installed version is read first: `pm2 --version` starts the daemon if
 * none is running, so the daemon Hawkeye connects to afterwards comes from
 * the installed PM2 and not from the client bundled in node_modules.
 *
 * @param {object} [options] - Injectable readers for tests.
 * @param {() => Promise<string|null>} [options.readCliVersion]
 * @param {() => Promise<string>} [options.readDaemonVersion]
 * @returns {Promise<string|null>} Error message, or null when all is well. A
 *   version that cannot be read counts as a failed check, not as a pass.
 */
export async function checkPm2Requirement({
  readCliVersion = readInstalledPm2Version,
  readDaemonVersion = getDaemonVersion,
} = {}) {
  try {
    const cliVersion = await readCliVersion();
    const cliProblem = pm2RequirementMessage({ cliVersion });
    if (cliProblem) return cliProblem;
    return pm2RequirementMessage({ cliVersion, daemonVersion: await readDaemonVersion() });
  } catch (err) {
    return `PM2-Hawkeye could not check the PM2 version: ${err.message}`;
  }
}
