/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useMemo } from 'react';
import { detectLogLevel } from '../services/format.js';

/** @param {string} text */
function isContinuationLine(text) {
  return /^\s+at\s/.test(text);
}

/** @param {string} level */
function levelClass(level) {
  if (level === 'error') return 'level-error';
  if (level === 'warn') return 'level-warn';
  if (level === 'info') return 'level-info';
  return '';
}

/** @param {string} level */
function levelLabel(level) {
  if (level === 'error') return 'ERR';
  if (level === 'warn') return 'WRN';
  if (level === 'info') return 'INF';
  return 'LOG';
}

/**
 * Extract an ISO timestamp prefix from a log line (from the `--time` PM2 flag).
 * Returns the time portion only (HH:MM:SS) or an empty string.
 *
 * @param {string} text
 * @returns {string}
 */
function extractTime(text) {
  const m = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  if (!m) return '';
  return m[1].slice(11, 19); // HH:MM:SS
}

/**
 * Log viewer panel with level-filter toolbar, text search, and a status footer.
 *
 * @param {{
 *   details: object | null,
 *   allLines: { text: string, logLevel?: string }[],
 *   logRef: React.RefObject,
 *   isMonitored: boolean,
 *   unreadCount: number,
 *   onScrollToBottom: () => void,
 *   logFilters: Set<string>,
 *   onToggleFilter: (level: string) => void,
 *   logSearch: string,
 *   onSearchChange: (s: string) => void,
 *   logPaused: boolean,
 *   onTogglePause: () => void,
 * }} props
 */
export default function LogStream({
  details,
  allLines,
  logRef,
  isMonitored,
  unreadCount = 0,
  onScrollToBottom,
  logFilters = new Set(['info', 'warn', 'error']),
  onToggleFilter,
  logSearch = '',
  onSearchChange,
  logPaused = false,
  onTogglePause,
}) {
  const annotatedLines = useMemo(() => {
    const result = [];
    let currentLevel = '';
    for (const line of allLines) {
      const continuation = isContinuationLine(line.text);
      const level = continuation
        ? ''
        : (line.logLevel !== undefined ? line.logLevel : detectLogLevel(line.text));
      if (!continuation) currentLevel = level;
      result.push({ ...line, level, isMain: !continuation, inheritedLevel: continuation ? currentLevel : level });
    }
    return result;
  }, [allLines]);

  const filteredLines = useMemo(() => {
    return annotatedLines.filter((line) => {
      const effectiveLevel = line.level || line.inheritedLevel || '';
      if (!logFilters.has(effectiveLevel) && logFilters.size < 3) {
        // Only apply level filter when at least one level is toggled off.
        // If effectiveLevel is empty (log/unknown), always show.
        if (effectiveLevel && !logFilters.has(effectiveLevel)) return false;
      }
      if (logSearch && !line.text.toLowerCase().includes(logSearch.toLowerCase())) return false;
      return true;
    });
  }, [annotatedLines, logFilters, logSearch]);

  const emptyText = isMonitored
    ? 'No log entries stored yet.'
    : 'No log output yet. Enable monitoring to persist logs.';

  /** Copy filtered log lines to clipboard. */
  const copyLogs = () => {
    const text = filteredLines.map((l) => l.text).join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  /** Download filtered log lines as a plain-text file. */
  const downloadLogs = () => {
    const text = filteredLines.map((l) => l.text).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${details?.name ?? 'logs'}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel section-shell log-section">
      <div className="log-toolbar">
        <div className="log-filter-pills">
          {['info', 'warn', 'error'].map((level) => (
            <button
              key={level}
              className={`log-filter-pill log-filter-pill--${level}${logFilters.has(level) ? ' active' : ''}`}
              type="button"
              onClick={() => onToggleFilter(level)}
            >
              {levelLabel(level)}
            </button>
          ))}
        </div>
        <div className="log-search-wrap">
          <svg className="log-search-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.25" />
            <line x1="7.8" y1="7.8" x2="10.5" y2="10.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
          <input
            className="log-search-input"
            type="text"
            placeholder="Search logs..."
            value={logSearch}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <div className="log-toolbar-actions">
          <button
            className={`log-icon-btn${logPaused ? ' log-icon-btn--active' : ''}`}
            type="button"
            title={logPaused ? 'Resume' : 'Pause'}
            onClick={onTogglePause}
          >
            {logPaused ? '▶' : '⏸'}
          </button>
          <button className="log-icon-btn" type="button" title="Copy logs" onClick={copyLogs}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <rect x="1" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
              <path d="M4 4V3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          </button>
          <button className="log-icon-btn" type="button" title="Download logs" onClick={downloadLogs}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="M6.5 2v7M4 7l2.5 2.5L9 7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 10.5h9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="log-stream-wrapper">
        <div
          ref={logRef}
          className={`log-stream${filteredLines.length ? '' : ' empty-state'}`}
        >
          {filteredLines.length ? filteredLines.map((line, i) => {
            const effectiveLevel = line.level || line.inheritedLevel || '';
            const timeStr = extractTime(line.text);
            return (
              <div
                className={`log-line${effectiveLevel ? ` ${levelClass(effectiveLevel)}` : ''}`}
                key={i}
              >
                {timeStr && <span className="log-time">{timeStr}</span>}
                {line.isMain && effectiveLevel && (
                  <span className={`log-level-badge log-level-badge--${effectiveLevel}`}>
                    {levelLabel(effectiveLevel)}
                  </span>
                )}
                {!line.isMain && <span className="log-level-badge log-level-badge--spacer" />}
                <span className="log-text">{line.text}</span>
              </div>
            );
          }) : (
            <div className="empty-card">{emptyText}</div>
          )}
        </div>
        {unreadCount > 0 && (
          <button type="button" className="new-logs-banner" onClick={onScrollToBottom}>
            {unreadCount} new line{unreadCount !== 1 ? 's' : ''} -- scroll to bottom
          </button>
        )}
      </div>

      <div className="log-footer">
        <span className="log-footer-dot" data-paused={logPaused} />
        <span className="log-footer-status">{logPaused ? 'Paused' : 'Live'}</span>
        <span className="log-footer-count">
          {filteredLines.length === allLines.length
            ? `${allLines.length} lines`
            : `${filteredLines.length} / ${allLines.length} lines`}
        </span>
        {details?.name && (
          <span className="log-footer-cmd">tail -f {details.name}</span>
        )}
      </div>
    </section>
  );
}
