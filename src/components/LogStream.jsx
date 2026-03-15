/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from "react";
import Pill from "./Pill.jsx";
import { detectLogLevel } from "../services/format.js";

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
  return "pill-info";
}

function levelToLabel(level) {
  if (level === "error") return "error";
  if (level === "warn") return "warning";
  return "info";
}

export default function LogStream({ details, allLines, logRef }) {


  // Build annotated lines: each line gets a level and whether it's a "main" line
  const annotatedLines = allLines.map((line) => {
    const continuation = isContinuationLine(line.text);
    const level = continuation ? "" : detectLogLevel(line.text);
    return { ...line, level, isMain: !continuation };
  });

  // Track current level for continuation lines (inherit from previous main line)
  let currentLevel = "";
  for (const line of annotatedLines) {
    if (line.isMain) {
      currentLevel = line.level;
    } else {
      line.inheritedLevel = currentLevel;
    }
  }

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

      <div ref={logRef} className={`log-stream ${allLines.length ? "" : "empty-state"}`.trim()}>
        <div className="log-stream-header">
          <span>Log output</span>
          <span className="live-badge"><span className="pulse" /> Live</span>
        </div>
        {allLines.length ? annotatedLines.map((line, i) => {
          const effectiveLevel = line.source || line.inheritedLevel || "";
          return (
            <div className={`log-line ${effectiveLevel ? `level-${effectiveLevel}` : ""}`.trim()} key={i}>
              {line.isMain && (
                <Pill
                  label={levelToLabel(effectiveLevel || "info")}
                  tone="neutral"
                  className={`log-source ${levelToPillClass(effectiveLevel || "info")}`}
                />
              )}
              {!line.isMain && <span className="log-source" style={{ display: "inline-block", minWidth: "3.5em" }} />}
              <span className="log-text">{line.text}</span>
            </div>
          );
        }) : (
          <div className="empty-card"><p>Log output will appear here once a process is selected.</p></div>
        )}
      </div>
    </section>
  );
}
