/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useState } from "react";

/**
 * Full-width notice bar shown between the hero card and the stats grid.
 *
 * **Unmonitored:** amber warning explaining that only live data is visible
 * and nothing is persisted, with a prominent "Start Monitoring" CTA.
 *
 * **Monitored:** compact green confirmation showing what is being stored,
 * with a "Stop Monitoring" button that asks for confirmation before removing
 * all stored history.
 *
 * @param {{
 *   isMonitored: boolean,
 *   pm2Name: string,
 *   onToggleMonitoring: (pm2Name: string, currentlyMonitored: boolean) => void,
 * }} props
 */
export default function MonitoringNotice({ isMonitored, pm2Name, onToggleMonitoring }) {
    const [confirmStop, setConfirmStop] = useState(false);

    // Reset confirmation state when the selected process changes.
    useEffect(() => {
        setConfirmStop(false);
    }, [pm2Name]);

    if (isMonitored) {
        if (confirmStop) {
            return (
                <div className="monitoring-notice monitoring-notice--confirm">
                    <div className="monitoring-notice-body">
                        <span className="monitoring-notice-dot monitoring-notice-dot--warning" />
                        <div className="monitoring-notice-content">
                            <strong className="monitoring-notice-headline monitoring-notice-headline--warning">
                                Remove all stored history for {pm2Name}?
                            </strong>
                            <p className="monitoring-notice-description">
                                This will permanently delete all stored metrics and log entries for this
                                process. This cannot be undone.
                            </p>
                        </div>
                    </div>
                    <div className="monitoring-notice-confirm-btns">
                        <button
                            className="monitoring-notice-action monitoring-notice-action--danger"
                            type="button"
                            onClick={() => {
                                onToggleMonitoring(pm2Name, true);
                                setConfirmStop(false);
                            }}
                        >
                            Yes, remove all history
                        </button>
                        <button
                            className="monitoring-notice-action monitoring-notice-action--ghost"
                            type="button"
                            onClick={() => setConfirmStop(false)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            );
        }

        return (
            <div className="monitoring-notice monitoring-notice--active">
                <div className="monitoring-notice-body">
                    <span className="monitoring-notice-dot monitoring-notice-dot--active" />
                    <span className="monitoring-notice-text">
                        <strong>Monitoring active</strong>
                        {" — "}
                        metrics sampled every 20 s (stored 24 h) &middot; logs stored for 14 days
                    </span>
                </div>
                <button
                    className="monitoring-notice-action monitoring-notice-action--ghost"
                    type="button"
                    onClick={() => setConfirmStop(true)}
                >
                    Stop Monitoring
                </button>
            </div>
        );
    }

    return (
        <div className="monitoring-notice monitoring-notice--warning">
            <div className="monitoring-notice-body">
                <span className="monitoring-notice-dot monitoring-notice-dot--warning" />
                <div className="monitoring-notice-content">
                    <strong className="monitoring-notice-headline">Not monitored &mdash; live data only</strong>
                    <p className="monitoring-notice-description">
                        Real-time values are visible for <strong>{pm2Name}</strong>, but nothing is saved.
                        Click <strong>Start Monitoring</strong> to persist CPU/memory history (24 h) and logs (14 days).
                    </p>
                </div>
            </div>
            <button
                className="monitoring-notice-action monitoring-notice-action--primary"
                type="button"
                onClick={() => onToggleMonitoring(pm2Name, false)}
            >
                Start Monitoring
            </button>
        </div>
    );
}
