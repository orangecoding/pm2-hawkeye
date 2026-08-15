/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useMemo } from 'react';
import { detectLogLevel } from '../services/format.js';
import { ArrowDown, Copy, DownloadSimple, MagnifyingGlass, Pause, Play } from './Icon.jsx';

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

/** ISO timestamp prefix written by PM2 when a process runs with `--time`. */
const TIME_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)[:\s]*/;

/**
 * Split a log line into its timestamp column and its message.
 *
 * The timestamp is rendered in its own column, so repeating the full ISO string
 * at the head of every message wasted roughly a third of the line width and
 * pushed the actual message off screen.
 *
 * @param {string} text
 * @returns {{ time: string, message: string }}
 */
function splitLine(text) {
  const m = text.match(TIME_PREFIX);
  if (!m) return { time: '', message: text };
  return { time: m[1].slice(11, 19), message: text.slice(m[0].length) };
}

/**
 * Log viewer.
 *
 * Filters, search, stream controls and live status all sit in one toolbar. The
 * panel used to be wrapped in two bars of chrome: a toolbar on top and a
 * separate status footer below carrying a duplicate live indicator, the line
 * count, and a decorative `tail -f` string.
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
 *   pausedCount: number,
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
  pausedCount = 0,
  onTogglePause,
}) {
  const annotatedLines = useMemo(() => {
    const result = [];
    let currentLevel = '';
    for (const line of allLines) {
      const continuation = isContinuationLine(line.text);
      const level = continuation ? '' : line.logLevel !== undefined ? line.logLevel : detectLogLevel(line.text);
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

  const isFiltered = filteredLines.length !== allLines.length;

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
    <section className="log-panel">
      <div className="log-toolbar">
        <div className="log-filters" role="group" aria-label="Filter by log level">
          {['info', 'warn', 'error'].map((level) => (
            <button
              key={level}
              type="button"
              className="log-filter"
              data-level={level}
              aria-pressed={logFilters.has(level)}
              onClick={() => onToggleFilter(level)}
            >
              {levelLabel(level)}
            </button>
          ))}
        </div>

        <div className="log-search">
          <MagnifyingGlass className="log-search-icon" size={12} weight="bold" />
          <input
            className="input"
            type="text"
            placeholder="Search"
            aria-label="Search logs"
            value={logSearch}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        <div className="log-toolbar-status">
          <span className="log-status-dot" data-paused={logPaused} />
          <span>{logPaused ? `Paused${pausedCount > 0 ? `, ${pausedCount} held` : ''}` : 'Live'}</span>
          <span className="log-count">
            {isFiltered ? `${filteredLines.length} of ${allLines.length}` : `${allLines.length}`} lines
          </span>
        </div>

        <div className="log-toolbar-actions">
          <button
            type="button"
            className="btn btn--icon"
            aria-pressed={logPaused}
            title={logPaused ? 'Resume the stream' : 'Pause the stream'}
            aria-label={logPaused ? 'Resume the stream' : 'Pause the stream'}
            onClick={onTogglePause}
          >
            {logPaused ? <Play size={13} weight="fill" /> : <Pause size={13} weight="fill" />}
          </button>
          <button
            type="button"
            className="btn btn--icon"
            title="Copy visible lines"
            aria-label="Copy visible lines"
            onClick={copyLogs}
          >
            <Copy size={14} />
          </button>
          <button
            type="button"
            className="btn btn--icon"
            title="Download visible lines"
            aria-label="Download visible lines"
            onClick={downloadLogs}
          >
            <DownloadSimple size={14} />
          </button>
        </div>
      </div>

      <div className="log-stream-wrapper">
        <div ref={logRef} className={filteredLines.length ? 'log-stream' : 'log-stream log-empty'}>
          {filteredLines.length ? (
            filteredLines.map((line, i) => {
              const effectiveLevel = line.level || line.inheritedLevel || '';
              const { time, message } = splitLine(line.text);
              return (
                <div className={`log-line${effectiveLevel ? ` ${levelClass(effectiveLevel)}` : ''}`} key={i}>
                  <span className="log-time">{time}</span>
                  {line.isMain && effectiveLevel ? (
                    <span className={`log-level-badge log-level-badge--${effectiveLevel}`}>
                      {levelLabel(effectiveLevel)}
                    </span>
                  ) : (
                    <span className="log-level-badge log-level-badge--spacer" />
                  )}
                  <span className="log-text">{message}</span>
                </div>
              );
            })
          ) : (
            <div className="empty-note">
              <strong>{allLines.length ? 'Nothing matches your filter' : 'No log output yet'}</strong>
              <p>
                {allLines.length
                  ? 'Clear the search box or re-enable a level to see more lines.'
                  : isMonitored
                    ? 'Lines appear here as the process writes them.'
                    : 'Lines appear here as the process writes them. Turn on monitoring in Manage to keep them between reloads.'}
              </p>
            </div>
          )}
        </div>

        {unreadCount > 0 && (
          <button type="button" className="new-logs-pill" onClick={onScrollToBottom}>
            <ArrowDown size={12} weight="bold" />
            {unreadCount} new line{unreadCount !== 1 ? 's' : ''}
          </button>
        )}
      </div>
    </section>
  );
}
