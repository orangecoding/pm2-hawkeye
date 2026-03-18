/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Background scheduler that samples CPU/memory for every monitored process
 * every 20 seconds and runs hourly retention purges.
 */

import { Cron } from 'croner';
import * as pm2 from './pm2Service.js';
import { getAllMonitored, reconcileOrphans } from '../storage/monitoringStorage.js';
import { insertMetric, purgeOldMetrics } from '../storage/metricsStorage.js';
import { purgeOldLogs } from '../storage/logStorage.js';
import logger from './logger.js';

/**
 * Start the metrics sampling cron (every 20 s) and the hourly purge cron.
 *
 * Both crons are `.unref()`-ed so they do not prevent the process from
 * exiting if nothing else keeps the event loop alive.
 */
export function startMetricsScheduler() {
  // Sample CPU/memory for every monitored process every 20 seconds.
  const sampler = new Cron('*/20 * * * * *', { protect: true }, async () => {
    try {
      const processes = await pm2.loadProcessList();
      const activeNames = processes.map((p) => p.name);
      reconcileOrphans(activeNames);

      const monitored = getAllMonitored();
      if (!monitored.length) return;

      const pm2Map = new Map(processes.map((p) => [p.name, p]));

      for (const row of monitored) {
        if (row.is_orphan) continue; // no live data available
        const proc = pm2Map.get(row.pm2_name);
        if (!proc) continue;

        const cpu = typeof proc.monit?.cpu === 'number' ? proc.monit.cpu : 0;
        const memory = typeof proc.monit?.memory === 'number' ? proc.monit.memory : 0;
        insertMetric(row.id, cpu, memory);
      }
    } catch (err) {
      logger.warn(`[METRICS_SCHEDULER] Sampling error: ${err.message}`);
    }
  });

  sampler.unref?.();

  // Purge stale records once an hour.
  const purger = new Cron('0 * * * *', { protect: true }, () => {
    try {
      purgeOldMetrics();
      purgeOldLogs();
    } catch (err) {
      logger.warn(`[METRICS_SCHEDULER] Purge error: ${err.message}`);
    }
  });

  purger.unref?.();

  // Run purges once on startup as well.
  try {
    purgeOldMetrics();
    purgeOldLogs();
  } catch (err) {
    logger.warn(`[METRICS_SCHEDULER] Startup purge error: ${err.message}`);
  }

  logger.info('[METRICS_SCHEDULER] Started (sample: 20 s, purge: 1 h)');
}
