/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Cross-platform host metrics collector.
 *
 * Collects CPU load, RAM usage, and root/C-drive disk usage without any
 * additional runtime dependencies beyond Node.js built-ins.
 */

import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

/**
 * Collect CPU load as a percentage on Linux and macOS.
 *
 * Uses `os.loadavg()[0] / cpuCount * 100`, capped at 100 %.
 * On Linux inside Docker the kernel load average reflects the host machine
 * rather than the container, so this gives real host CPU load.
 *
 * @returns {number}
 */
function cpuLinuxMac() {
  const cpuCount = os.cpus().length || 1;
  return Math.min((os.loadavg()[0] / cpuCount) * 100, 100);
}

/**
 * Collect CPU load percentage on Windows via `wmic`.
 *
 * @returns {Promise<number>}
 */
async function cpuWindows() {
  const { stdout } = await execFileAsync('wmic', ['cpu', 'get', 'LoadPercentage', '/value'], {
    timeout: 5000,
  });
  const match = stdout.match(/LoadPercentage=(\d+)/);
  if (!match) throw new Error('Cannot parse wmic output');
  return parseInt(match[1], 10);
}

/**
 * Collect disk usage for the root filesystem on Linux and macOS using POSIX
 * `df -Pk /`.
 *
 * @returns {Promise<{ percent: number, used: number, total: number }>}
 *   Usage percentage plus used and total bytes.
 */
async function diskLinuxMac() {
  const { stdout } = await execFileAsync('df', ['-Pk', '/'], { timeout: 5000 });
  // POSIX df -Pk format:
  //   Filesystem  1024-blocks  Used  Available  Use%  Mounted on
  //   /dev/sda1   102400000    51200000  51200000  50%  /
  const lines = stdout.trim().split('\n');
  const dataLine = lines[1];
  if (!dataLine) throw new Error('df output has no data line');
  const cols = dataLine.trim().split(/\s+/);
  const totalKb = parseInt(cols[1], 10); // 1024-blocks
  const usedKb = parseInt(cols[2], 10);
  const usePercent = parseInt(cols[4], 10); // "50%"
  if (isNaN(totalKb) || isNaN(usedKb)) throw new Error('Cannot parse df size columns');
  const total = totalKb * 1024;
  const used = usedKb * 1024;
  const percent = isNaN(usePercent) ? (used / total) * 100 : usePercent;
  return { percent, used, total };
}

/**
 * Collect disk usage for the C: drive on Windows via PowerShell.
 *
 * @returns {Promise<{ percent: number, used: number, total: number }>}
 *   Usage percentage plus used and total bytes.
 */
async function diskWindows() {
  const script = 'Get-PSDrive C | Select-Object Used,Free | ConvertTo-Csv -NoTypeInformation';
  const { stdout } = await execFileAsync('powershell', ['-Command', script], { timeout: 8000 });
  const lines = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // lines[0] = '"Used","Free"', lines[1] = '12345,67890'
  if (lines.length < 2) throw new Error('Cannot parse PowerShell output');
  const [usedStr, freeStr] = lines[1].replace(/"/g, '').split(',');
  const used = parseFloat(usedStr);
  const free = parseFloat(freeStr);
  if (isNaN(used) || isNaN(free)) throw new Error('Cannot parse disk values');
  const total = used + free;
  return { percent: (used / total) * 100, used, total };
}

/**
 * Collect RAM usage percentage on macOS using `vm_stat`.
 *
 * macOS's `os.freemem()` only returns truly-free (wired-to-nothing) pages and
 * ignores inactive and speculative pages that the kernel will immediately
 * reclaim on demand. This causes wildly inflated usage readings. `vm_stat`
 * exposes those page categories so we can compute a realistic "available"
 * figure: free + inactive + speculative pages.
 *
 * @returns {Promise<{ percent: number, used: number, total: number }>}
 *   Usage percentage plus used and total bytes.
 */
async function ramMacOS() {
  const { stdout } = await execFileAsync('vm_stat', [], { timeout: 5000 });

  // First line: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
  const pageSizeMatch = stdout.match(/page size of (\d+) bytes/);
  if (!pageSizeMatch) throw new Error('Cannot parse vm_stat page size');
  const pageSize = parseInt(pageSizeMatch[1], 10);

  /**
   * Helper that extracts a page count from a vm_stat output line.
   * Lines look like: "Pages free:                   176094."
   *
   * @param {string} label - the vm_stat label, e.g. "Pages free"
   * @returns {number}
   */
  function parsePages(label) {
    const re = new RegExp(`${label}:\\s+([\\d]+)\\.`);
    const m = stdout.match(re);
    if (!m) throw new Error(`Cannot parse vm_stat field: ${label}`);
    return parseInt(m[1], 10);
  }

  const free = parsePages('Pages free');
  const inactive = parsePages('Pages inactive');
  const speculative = parsePages('Pages speculative');

  const total = os.totalmem();
  const availableBytes = (free + inactive + speculative) * pageSize;
  const used = Math.max(total - availableBytes, 0);
  const percent = Math.min(Math.max((used / total) * 100, 0), 100);
  return { percent, used, total };
}

/**
 * Collect RAM usage percentage on Linux using `/proc/meminfo`.
 *
 * Linux's `MemAvailable` (added in kernel 3.14) is the kernel's own estimate
 * of how much memory can be freed for new allocations without swapping. It
 * accounts for reclaimable cache and is far more accurate than
 * `os.freemem()`.
 *
 * @returns {Promise<{ percent: number, used: number, total: number }>}
 *   Usage percentage plus used and total bytes.
 */
async function ramLinux() {
  const content = await readFile('/proc/meminfo', 'utf8');

  /**
   * Parses a kB value from a /proc/meminfo line.
   *
   * @param {string} label - field name, e.g. "MemTotal"
   * @returns {number} value in bytes
   */
  function parseKb(label) {
    const re = new RegExp(`^${label}:\\s+(\\d+)\\s+kB`, 'm');
    const m = content.match(re);
    if (!m) throw new Error(`Cannot parse /proc/meminfo field: ${label}`);
    return parseInt(m[1], 10) * 1024;
  }

  const total = parseKb('MemTotal');
  const available = parseKb('MemAvailable');
  const used = Math.max(total - available, 0);
  const percent = Math.min(Math.max((used / total) * 100, 0), 100);
  return { percent, used, total };
}

/**
 * RAM usage fallback using only Node.js built-ins.
 *
 * Used on Windows and whenever the platform-specific collectors throw. Note
 * that `os.freemem()` undercounts reclaimable memory on macOS and Linux, so
 * this is a last resort rather than the primary path on those platforms.
 *
 * @returns {{ percent: number, used: number, total: number }}
 */
function ramFallback() {
  const total = os.totalmem();
  const used = Math.max(total - os.freemem(), 0);
  const percent = Math.min(Math.max((used / total) * 100, 0), 100);
  return { percent, used, total };
}

/**
 * Collect current host-level CPU load, RAM usage, and disk usage.
 *
 * Platform notes:
 * - CPU: load average on Linux/macOS (reflects host kernel even in Docker);
 *   `wmic` on Windows.
 * - RAM: platform-specific implementations for accuracy. macOS uses `vm_stat`
 *   to include inactive and speculative pages as "available". Linux reads
 *   `MemAvailable` from `/proc/meminfo`. Windows and error fallback use
 *   `os.freemem()`.
 * - Disk: root filesystem on Linux/macOS; C: drive on Windows.
 *
 * Any metric that cannot be collected is returned as `null` so callers can
 * skip partial samples rather than storing misleading zeroes.  RAM and disk
 * additionally expose absolute used/total bytes for richer display.
 *
 * @typedef {{
 *   cpu: number|null,
 *   ram: number|null, ramUsed: number|null, ramTotal: number|null,
 *   disk: number|null, diskUsed: number|null, diskTotal: number|null,
 * }} HostMetricsReading
 */

/**
 * Most recent reading produced by {@link collectHostMetrics}, kept in memory so
 * the HTTP layer can surface current absolute used/total bytes (which are not
 * stored in the percentage-only history table) without spawning extra
 * subprocesses on every request.
 *
 * @type {HostMetricsReading|null}
 */
let lastReading = null;

/**
 * Collect a fresh host reading and cache it for {@link getLastHostReading}.
 *
 * @returns {Promise<HostMetricsReading>}
 */
export async function collectHostMetrics() {
  const platform = os.platform();
  const isWindows = platform === 'win32';

  const cpuPromise = isWindows ? cpuWindows().catch(() => null) : Promise.resolve(cpuLinuxMac());

  const diskPromise = isWindows ? diskWindows().catch(() => null) : diskLinuxMac().catch(() => null);

  let ramPromise;
  if (platform === 'darwin') {
    ramPromise = ramMacOS().catch(() => ramFallback());
  } else if (platform === 'linux') {
    ramPromise = ramLinux().catch(() => ramFallback());
  } else {
    ramPromise = Promise.resolve(ramFallback());
  }

  const [cpu, disk, ram] = await Promise.all([cpuPromise, diskPromise, ramPromise]);

  const reading = {
    cpu: typeof cpu === 'number' ? parseFloat(cpu.toFixed(1)) : null,
    ram: ram ? parseFloat(ram.percent.toFixed(1)) : null,
    ramUsed: ram ? ram.used : null,
    ramTotal: ram ? ram.total : null,
    disk: disk ? parseFloat(disk.percent.toFixed(1)) : null,
    diskUsed: disk ? disk.used : null,
    diskTotal: disk ? disk.total : null,
  };

  lastReading = reading;
  return reading;
}

/**
 * Return the most recent full host reading, or `null` if none has been
 * collected yet (e.g. before the first scheduler tick).
 *
 * @returns {HostMetricsReading|null}
 */
export function getLastHostReading() {
  return lastReading;
}
