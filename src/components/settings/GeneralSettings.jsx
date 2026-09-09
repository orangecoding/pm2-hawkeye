/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useState } from 'react';
import { fetchJson, fetchWithCsrf } from '../../services/api.js';

/**
 * Human-readable presentation for each known .env key.
 *
 * The page previously rendered whatever the server returned as a flat list of
 * SCREAMING_SNAKE_CASE labels, which asked the reader to already know what
 * every variable did and in what unit. Keys not listed here still render, in
 * the "Other" group, using the raw key as the label.
 */
const FIELD_META = {
  HOST: { group: 'Server', label: 'Bind address', hint: 'Network interface the dashboard listens on.' },
  PORT: { group: 'Server', label: 'Port', hint: 'HTTP and WebSocket port.' },
  TRUST_PROXY: {
    group: 'Server',
    label: 'Behind a reverse proxy',
    hint: 'Set to 1 when a proxy sets X-Forwarded-For and X-Forwarded-Proto.',
  },
  COOKIE_SECURE: {
    group: 'Server',
    label: 'Secure cookies',
    hint: 'auto, always, or never. Use always when the dashboard is served over HTTPS.',
  },

  AUTH_USERNAME: { group: 'Sign in', label: 'Username', hint: 'Case-insensitive and trimmed on login.' },
  SESSION_TTL_MS: {
    group: 'Sign in',
    label: 'Session lifetime',
    unit: 'ms',
    hint: 'How long a signed-in session stays valid. 28800000 is 8 hours.',
  },

  AUTH_MIN_RESPONSE_MS: {
    group: 'Brute-force protection',
    label: 'Minimum login response time',
    unit: 'ms',
    hint: 'Every login attempt takes at least this long, so a wrong username cannot be told apart from a wrong password by timing.',
  },
  LOGIN_WINDOW_MS: {
    group: 'Brute-force protection',
    label: 'Attempt window',
    unit: 'ms',
    hint: 'Sliding window used to count login attempts.',
  },
  LOGIN_MAX_REQUESTS: {
    group: 'Brute-force protection',
    label: 'Attempts per window',
    hint: 'Attempts allowed inside the window before requests are refused.',
  },
  LOGIN_FAILURE_WINDOW_MS: {
    group: 'Brute-force protection',
    label: 'Failure window',
    unit: 'ms',
    hint: 'Period over which consecutive failures are counted for lockout.',
  },
  LOGIN_BASE_LOCKOUT_MS: {
    group: 'Brute-force protection',
    label: 'First lockout',
    unit: 'ms',
    hint: 'Lockout after the first burst of failures. Doubles with each further burst.',
  },
  LOGIN_MAX_LOCKOUT_MS: {
    group: 'Brute-force protection',
    label: 'Longest lockout',
    unit: 'ms',
    hint: 'Upper bound on the doubling lockout.',
  },
  UNAUTH_WINDOW_MS: {
    group: 'Brute-force protection',
    label: 'Anonymous request window',
    unit: 'ms',
    hint: 'Rate-limit window for requests without a session.',
  },
  UNAUTH_MAX_REQUESTS: {
    group: 'Brute-force protection',
    label: 'Anonymous requests per window',
    hint: 'Requests allowed without a session before throttling kicks in.',
  },
  UNAUTH_PENALTY_MS: {
    group: 'Brute-force protection',
    label: 'Anonymous throttle delay',
    unit: 'ms',
    hint: 'Delay applied once the anonymous limit is exceeded.',
  },

  MAX_LOG_BYTES_PER_FILE: {
    group: 'Logs and retention',
    label: 'Maximum bytes read per log file',
    unit: 'bytes',
    hint: 'Cap on how much of each PM2 log file is read. 5242880 is 5 MB.',
  },
  METRICS_RETENTION_MS: {
    group: 'Logs and retention',
    label: 'Keep metrics for',
    unit: 'ms',
    hint: 'How long CPU and memory samples are stored. 86400000 is 24 hours.',
  },
  LOGS_RETENTION_MS: {
    group: 'Logs and retention',
    label: 'Keep logs for',
    unit: 'ms',
    hint: 'How long stored log lines are kept. 1209600000 is 14 days.',
  },

  DEPLOY_BASE_DIR: {
    group: 'Deployments',
    label: 'Deploy directory',
    hint: 'Base directory repositories are cloned into, relative to the app root unless absolute.',
  },
  SQLITE_DB_PATH: {
    group: 'Deployments',
    label: 'Database location',
    hint: 'Path to the SQLite file, or a directory in which pm2-hawkeye.db is created.',
  },
};

/** Order groups are rendered in. Unknown keys collect into "Other". */
const GROUP_ORDER = ['Server', 'Sign in', 'Brute-force protection', 'Logs and retention', 'Deployments', 'Other'];

/**
 * General settings page.
 *
 * Reads all KEY=VALUE pairs from the .env file on the server (via
 * GET /api/settings/general) and renders them grouped by concern with plain
 * labels. Sensitive keys (AUTH_PASSWORD_SALT, AUTH_PASSWORD_HASH) are never
 * returned by the server. A dedicated password field handles password updates.
 *
 * On save, the raw env key names and their new values are sent to
 * POST /api/settings/general, which writes them back to .env on disk.
 *
 * @param {{
 *   csrfToken: string | null,
 *   onCsrfRefresh: () => Promise<void>,
 * }} props
 */
export default function GeneralSettings({ csrfToken, onCsrfRefresh }) {
  const [fields, setFields] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  // Fetch current .env values on mount.
  useEffect(() => {
    fetchJson('/api/settings/general')
      .then((payload) => {
        setFields(payload.settings ?? {});
      })
      .catch((err) => {
        setNotice({ type: 'error', text: `Failed to load settings: ${err.message}` });
      })
      .finally(() => setLoading(false));
  }, []);

  /**
   * @param {string} key
   * @param {string} value
   */
  function set(key, value) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!csrfToken || !fields) return;
    setSaving(true);
    setNotice(null);
    try {
      const settings = { ...fields };
      if (newPassword.trim()) {
        settings.authPassword = newPassword.trim();
      }
      await fetchWithCsrf('/api/settings/general', {
        onCsrfRefresh,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      setNotice({ type: 'success', text: 'Saved. Restart pm2-hawkeye for the changes to take effect.' });
      setNewPassword('');
    } catch (err) {
      setNotice({ type: 'error', text: err.message ?? 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="settings-page">
        <div className="settings-skeleton" />
        <div className="settings-skeleton" />
        <div className="settings-skeleton" />
      </div>
    );
  }

  const keys = fields ? Object.keys(fields) : [];

  // Bucket every key into its group, keeping unknown keys visible under "Other".
  const grouped = {};
  for (const key of keys) {
    const group = FIELD_META[key]?.group ?? 'Other';
    (grouped[group] ??= []).push(key);
  }

  return (
    <form className="settings-page" onSubmit={handleSave}>
      <p className="hint">
        These are written to the .env file on the server. Restart pm2-hawkeye for them to take effect.
      </p>

      {notice && <div className={`settings-notice settings-notice--${notice.type}`}>{notice.text}</div>}

      {keys.length === 0 && <p className="hint">No .env file found. It will be created when you save.</p>}

      {GROUP_ORDER.filter((group) => grouped[group]?.length).map((group) => (
        <section className="settings-group" key={group}>
          <h3 className="settings-group-title">{group}</h3>
          <div className="settings-group-fields">
            {grouped[group].map((key) => {
              const meta = FIELD_META[key];
              return (
                <div className="field" key={key}>
                  <label htmlFor={`gs-${key}`}>
                    {meta?.label ?? key}
                    {meta?.unit && <span className="settings-unit">{meta.unit}</span>}
                  </label>
                  <input
                    id={`gs-${key}`}
                    className="input"
                    type="text"
                    value={fields[key] ?? ''}
                    onChange={(e) => set(key, e.target.value)}
                    autoComplete="off"
                  />
                  <p className="hint">
                    {meta?.hint ? `${meta.hint} ` : ''}
                    <code>{key}</code>
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <section className="settings-group">
        <h3 className="settings-group-title">Password</h3>
        <div className="settings-group-fields">
          <div className="field">
            <label htmlFor="gs-new-password">New password</label>
            <input
              id="gs-new-password"
              className="input"
              type="password"
              value={newPassword}
              placeholder="Leave blank to keep the current one"
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <p className="hint">A new salt and hash are derived on save. The plaintext is never stored.</p>
          </div>
        </div>
      </section>

      <div className="settings-actions">
        <button className="btn btn--primary" type="submit" disabled={saving}>
          {saving ? 'Saving' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
