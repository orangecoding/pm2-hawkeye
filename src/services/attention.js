/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { formatClock } from './chart.js';
import { formatBytesOf } from './format.js';
import { DEPLOY_STAGES, offlineStatus, planDeploy } from './deployment.js';

/** Host utilisation from which the Overview raises an item. */
const HOST_CRITICAL_PCT = 90;

/** Longest error excerpt an attention row shows. */
const DETAIL_MAX = 140;

/**
 * Shorten a message to its first line and at most {@link DETAIL_MAX} characters.
 *
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  const line =
    String(text || '')
      .split('\n')
      .find((l) => l.trim()) ?? '';
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1).trimEnd()}…` : line.trim();
}

/**
 * Title of the step a failed run stopped at, e.g. `Build`.
 *
 * @param {object} deployment
 * @param {{ stage: string }[]} lines - Progress events of the run.
 * @returns {string}
 */
function failedStepTitle(deployment, lines) {
  const lastReal = [...lines].reverse().find((l) => DEPLOY_STAGES.includes(l.stage));
  const steps = planDeploy(deployment, { firstDeploy: deployment.last_deployed_at == null });
  return steps.find((s) => s.stage === (lastReal?.stage ?? 'clone'))?.title ?? 'Update the code';
}

/**
 * Build the Overview's "Needs attention" list: every condition the user should
 * act on, critical first, then warnings, each group sorted by name.
 *
 * Stopped processes are deliberately not listed: stopping is something the
 * user did, not something that went wrong.
 *
 * @param {{
 *   processes: { id: number|null, name: string, status: string, restarts?: number }[],
 *   offlineDeployments: object[],
 *   deployments: object[],
 *   deployRuns: Record<string, { lines: object[], status: string|null }>,
 *   hostCurrent: { cpu: number|null, ram: number|null, disk: number|null,
 *     ramUsed?: number, ramTotal?: number, diskUsed?: number, diskTotal?: number } | null,
 * }} input
 * @returns {{ key: string, level: 'critical'|'warning', name: string, title: string, detail: string,
 *   action: { label: string, kind: 'logs'|'deployment'|'host', processKey?: number|string, deploymentId?: string } }[]}
 */
export function buildAttentionItems({ processes, offlineDeployments, deployments, deployRuns, hostCurrent }) {
  const items = [];

  for (const proc of processes) {
    if (String(proc.status ?? '').toLowerCase() !== 'errored') continue;
    items.push({
      key: `errored:${proc.name}`,
      level: 'critical',
      name: proc.name,
      title: `${proc.name} is errored`,
      detail: `${proc.restarts ?? 0} restarts. PM2 has stopped restarting it.`,
      action: { label: 'Open logs', kind: 'logs', processKey: proc.id ?? proc.name },
    });
  }

  for (const dep of offlineDeployments) {
    if (offlineStatus(dep) !== 'broken') continue;
    items.push({
      key: `broken:${dep.id}`,
      level: 'critical',
      name: dep.pm2_name,
      title: `${dep.pm2_name} was never deployed successfully`,
      detail: 'Its first deployment failed, so nothing runs in PM2.',
      action: { label: 'Open deployment', kind: 'deployment', deploymentId: dep.id },
    });
  }

  const brokenIds = new Set(offlineDeployments.filter((d) => offlineStatus(d) === 'broken').map((d) => d.id));
  for (const dep of deployments) {
    const run = deployRuns[dep.id];
    const last = run?.lines.at(-1);
    if (!run || !last) continue;
    if (last.stage === 'error' && !brokenIds.has(dep.id)) {
      items.push({
        key: `run-failed:${dep.id}`,
        level: 'critical',
        name: dep.pm2_name,
        title: `${dep.pm2_name}: redeploy failed at ${failedStepTitle(dep, run.lines)}`,
        detail: firstLine(last.line),
        action: { label: 'Open deployment', kind: 'deployment', deploymentId: dep.id },
      });
    } else if (last.status === 'confirm') {
      items.push({
        key: `run-confirm:${dep.id}`,
        level: 'warning',
        name: dep.pm2_name,
        title: `${dep.pm2_name}: deployment is waiting for you`,
        detail: 'Local changes in the deploy folder need a decision.',
        action: { label: 'Open deployment', kind: 'deployment', deploymentId: dep.id },
      });
    }
  }

  if (hostCurrent) {
    const host = [
      {
        key: 'disk',
        value: hostCurrent.disk,
        title: (v) => `Disk is ${Math.round(v)}% full`,
        detail:
          hostCurrent.diskUsed != null && hostCurrent.diskTotal != null
            ? `${formatBytesOf(hostCurrent.diskUsed, hostCurrent.diskTotal)} used on this machine.`
            : 'On this machine.',
      },
      {
        key: 'ram',
        value: hostCurrent.ram,
        title: (v) => `RAM is ${Math.round(v)}% used`,
        detail:
          hostCurrent.ramUsed != null && hostCurrent.ramTotal != null
            ? `${formatBytesOf(hostCurrent.ramUsed, hostCurrent.ramTotal)} used on this machine.`
            : 'On this machine.',
      },
      {
        key: 'cpu',
        value: hostCurrent.cpu,
        title: (v) => `CPU is at ${Math.round(v)}%`,
        detail: 'Average across all cores.',
      },
    ];
    for (const metric of host) {
      if (metric.value == null || metric.value < HOST_CRITICAL_PCT) continue;
      items.push({
        key: `host:${metric.key}`,
        level: 'critical',
        // Host items sort after the named ones of their level.
        name: '￿',
        title: metric.title(metric.value),
        detail: metric.detail,
        action: { label: 'Show host', kind: 'host' },
      });
    }
  }

  for (const dep of deployments) {
    if (!dep.watch_last_error) continue;
    const at = dep.watch_last_checked_at ? `Last check at ${formatClock(dep.watch_last_checked_at)}: ` : '';
    items.push({
      key: `watch:${dep.id}`,
      level: 'warning',
      name: dep.pm2_name,
      title: `${dep.pm2_name} auto-deploy check failed`,
      detail: `${at}${firstLine(dep.watch_last_error)}${at ? '.' : ''}`,
      action: { label: 'Open deployment', kind: 'deployment', deploymentId: dep.id },
    });
  }

  const rank = { critical: 0, warning: 1 };
  return items.sort((a, b) => rank[a.level] - rank[b.level] || a.name.localeCompare(b.name));
}
