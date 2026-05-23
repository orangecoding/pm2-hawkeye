/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useState } from 'react';

/**
 * Compact inline monitoring strip rendered below the process header.
 *
 * Active (green tint): monitoring on, logs and metrics persisted.
 * Inactive (neutral): live data only, nothing stored.
 * Shows a confirmation prompt before disabling to warn about history deletion.
 *
 * @param {{
 *   isMonitored: boolean,
 *   pm2Name: string,
 *   onToggleMonitoring: (pm2Name: string, currentlyMonitored: boolean) => void,
 *   metricsRetentionMs: number,
 *   logsRetentionMs: number,
 * }} props
 */
export default function MonitoringNotice({ isMonitored, pm2Name, onToggleMonitoring }) {
  const [confirmStop, setConfirmStop] = useState(false);

  useEffect(() => {
    setConfirmStop(false);
  }, [pm2Name]);

  if (confirmStop) {
    return (
      <div className="monitoring-strip" data-active="true">
        <span className="monitoring-strip-dot" />
        <span className="monitoring-strip-label">Remove all stored history for {pm2Name}?</span>
        <button
          className="monitoring-strip-btn"
          type="button"
          onClick={() => { onToggleMonitoring(pm2Name, true); setConfirmStop(false); }}
        >
          Yes, remove
        </button>
        <button
          className="monitoring-strip-btn"
          type="button"
          onClick={() => setConfirmStop(false)}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="monitoring-strip" data-active={isMonitored}>
      <span className="monitoring-strip-dot" />
      <span className="monitoring-strip-label">
        {isMonitored ? 'Monitoring active' : 'Not monitored'}
      </span>
      <button
        className="monitoring-strip-btn"
        type="button"
        onClick={() => isMonitored ? setConfirmStop(true) : onToggleMonitoring(pm2Name, false)}
      >
        {isMonitored ? 'Disable' : 'Enable'}
      </button>
    </div>
  );
}
