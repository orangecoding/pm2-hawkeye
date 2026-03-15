/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** @type {Record<string, string>} ANSI escape codes for coloring log levels in terminal output */
const COLORS = {
    debug: '\x1b[36m', // cyan
    info: '\x1b[32m',  // green
    warn: '\x1b[33m',  // yellow
    error: '\x1b[31m', // red
    reset: '\x1b[0m',
};

const env = process.env.NODE_ENV || 'development';
/** Only colorize output when writing to an actual terminal (not piped/redirected) */
const useColor = process.stdout.isTTY || process.stderr.isTTY;

/**
 * Returns a formatted timestamp string.
 * @returns {string} Timestamp in `YYYY-MM-DD HH:MM:SS` format
 */
function ts() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/**
 * Returns the log level label, wrapped in ANSI color codes if the terminal supports it.
 * @param {'debug'|'info'|'warn'|'error'} level - The log level
 * @returns {string} Uppercased level label, optionally colorized
 */
function lvl(level) {
    const upper = level.toUpperCase();
    if (!useColor) return upper;
    return `${COLORS[level] || ''}${upper}${COLORS.reset}`;
}

/* eslint-disable no-console */
/**
 * Core logging function — routes to the appropriate console method per level.
 * Debug messages are suppressed outside of development environments.
 * @param {'debug'|'info'|'warn'|'error'} level - The log level
 * @param {...*} args - Values to log
 */
function log(level, ...args) {
    if (level === 'debug' && env !== 'development') {
        return;
    }

    const prefix = `[${ts()}] ${lvl(level)}:`;
    switch (level) {
        case 'debug':
            console.debug(prefix, ...args);
            break;
        case 'info':
            console.info(prefix, ...args);
            break;
        case 'warn':
            console.warn(prefix, ...args);
            break;
        case 'error':
            console.error(prefix, ...args);
            break;
        default:
            console.log(prefix, ...args);
    }
}

/**
 * Simple logger with level-based filtering and optional terminal colorization.
 * Debug output is only emitted when `NODE_ENV=development`.
 * @namespace logger
 */
export default {
    /** @param {...*} a - Values to log at debug level */
    debug: (...a) => log('debug', ...a),
    /** @param {...*} a - Values to log at info level */
    info: (...a) => log('info', ...a),
    /** @param {...*} a - Values to log at warn level */
    warn: (...a) => log('warn', ...a),
    /** @param {...*} a - Values to log at error level */
    error: (...a) => log('error', ...a),
};
