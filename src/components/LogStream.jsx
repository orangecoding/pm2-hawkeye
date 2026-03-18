/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from "react";
import Pill from "./Pill.jsx";
import {detectLogLevel} from "../services/format.js";

/**
 * Detect if a line is a "continuation" (e.g. stack trace "at ..." lines).
 * Main log lines get a pill; continuation lines do not.
 */
function isContinuationLine(text) {
    return /^\s+at\s/.test(text);
}

function levelToPillClass(level) {
    if (level === "error") return "pill-error";
    if (level === "warn") return "pill-warn";
    if (level === "info") return "pill-info";
    return "pill-log";
}

function levelToLabel(level) {
    if (level === "error") return "error";
    if (level === "warn") return "warning";
    if (level === "info") return "info";
    return "log";
}

/**
 * Log viewer panel.
 *
 * For **monitored** processes the log data comes from the database (persisted
 * history).  For **unmonitored** processes only the live WebSocket stream is
 * shown and data is lost when you navigate away.
 *
 * @param {{
 *   details: object | null,
 *   allLines: {text: string, logLevel?: string}[],
 *   logRef: React.RefObject,
 *   isMonitored: boolean,
 *   unreadCount: number,
 *   onScrollToBottom: () => void,
 * }} props
 */
export default function LogStream({details, allLines, logRef, isMonitored, unreadCount = 0, onScrollToBottom}) {
    // Build annotated lines: each line gets a level and whether it is a "main" line.
    // Prefer a pre-computed logLevel (stored DB entries) to avoid re-detection.
    // For lines without a pre-computed level, fall back to text-based detection.
    const annotatedLines = allLines.map((line) => {
        const continuation = isContinuationLine(line.text);
        const level = continuation ? "" : (line.logLevel !== undefined ? line.logLevel : detectLogLevel(line.text));
        return {...line, level, isMain: !continuation};
    });

    // Continuation lines inherit the log level of the preceding main line.
    let currentLevel = "";
    for (const line of annotatedLines) {
        if (line.isMain) {
            currentLevel = line.level;
        } else {
            line.inheritedLevel = currentLevel;
        }
    }

    const headerBadge = isMonitored ? (
        <span className="stored-badge">
            <span className="stored-dot"/>
            Stored
        </span>
    ) : (
        <span className="live-badge live-badge--warning">
            <span className="pulse pulse--warning"/>
            Live only
        </span>
    );

    const emptyText = isMonitored
        ? "No log entries stored yet. New log lines will appear here as they are written."
        : "No log output yet. Note: logs are not being saved — enable monitoring to persist them.";

    return (
        <section className="panel section-shell">
            <div className="panel-header">
                <div>
                    <p className="eyebrow">Log Stream</p>
                    <h3>Process logs</h3>
                </div>
                <div className="log-header-right">
                    <p className="subtle">
                        {details ? `${allLines.length} lines` : "No data"}
                    </p>
                </div>
            </div>

            <div className="log-stream-wrapper">
            <div ref={logRef} className={`log-stream ${allLines.length ? "" : "empty-state"}`.trim()}>
                <div className="log-stream-header">
                    <span>Log output</span>
                    {headerBadge}
                </div>
                {allLines.length ? annotatedLines.map((line, i) => {
                    const effectiveLevel = line.level || line.inheritedLevel || "";
                    return (
                        <div
                            className={`log-line ${effectiveLevel ? `level-${effectiveLevel}` : ""}`.trim()}
                            key={i}
                        >
                            {line.isMain && (
                                <Pill
                                    label={levelToLabel(effectiveLevel)}
                                    tone="neutral"
                                    className={`log-source ${levelToPillClass(effectiveLevel)}`}
                                />
                            )}
                            {!line.isMain && (
                                <span className="log-source"
                                      style={{display: "inline-block", minWidth: "3.5em"}}/>
                            )}
                            <span className="log-text">{line.text}</span>
                        </div>
                    );
                }) : (
                    <div className="empty-card">{emptyText}</div>
                )}
            </div>
            {unreadCount > 0 && (
                <button type="button" className="new-logs-banner" onClick={onScrollToBottom}>
                    {unreadCount} new line{unreadCount !== 1 ? "s" : ""} -- scroll to bottom
                </button>
            )}
            </div>
        </section>
    );
}
