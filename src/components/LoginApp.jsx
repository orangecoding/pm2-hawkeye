/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useRef, useState } from 'react';
import { Eye } from './Icon.jsx';

/**
 * Sign-in page.
 *
 * The two labels above the headings ("LOGIN", "AUTHENTICATION") were dropped:
 * on a page with one form and one purpose they named what the heading directly
 * below them already said.
 */
export default function LoginApp() {
  /** @type {[{text: string, tone: 'muted'|'error'|'success'}, Function]} */
  const [message, setMessage] = useState({ text: '', tone: 'muted' });
  const [submitting, setSubmitting] = useState(false);
  const usernameRef = useRef(null);
  const passwordRef = useRef(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const username = usernameRef.current.value.trim();
    const password = passwordRef.current.value;

    if (!username || !password) {
      setMessage({ text: 'Enter both a username and a password.', tone: 'error' });
      return;
    }

    setSubmitting(true);
    setMessage({ text: '', tone: 'muted' });

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const retryAfter = payload?.retryAfterSeconds
          ? ` Try again in about ${payload.retryAfterSeconds} second(s).`
          : '';
        throw new Error((payload.error || 'Sign-in failed.') + retryAfter);
      }

      setMessage({ text: 'Signed in. Taking you to the dashboard.', tone: 'success' });
      window.location.replace('/');
    } catch (err) {
      setMessage({ text: err.message, tone: 'error' });
      passwordRef.current?.focus();
      passwordRef.current?.select();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-brand">
          <span className="login-brand-mark">
            <Eye size={20} weight="bold" color="var(--accent)" />
          </span>
          <h1>
            <span className="brand-pm2">pm2</span>
            <span className="brand-hawkeye">-hawkeye</span>
          </h1>
          <p className="subtle">
            Live process monitoring, merged log streaming, and one-click deployments for the PM2 daemon on this
            server.
          </p>
        </div>

        <div className="login-form-side">
          <h2>Sign in</h2>
          <p className="hint">Use the administrator credentials from your .env file.</p>

          <form className="login-form" noValidate onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="login-username">Username</label>
              <input
                id="login-username"
                className="input"
                ref={usernameRef}
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck="false"
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label htmlFor="login-password">Password</label>
              <input
                id="login-password"
                className="input"
                ref={passwordRef}
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>

            <button className="btn btn--primary btn--block login-submit" type="submit" disabled={submitting}>
              {submitting ? 'Signing in' : 'Sign in'}
            </button>

            {/* Space is reserved so the button does not shift when a message appears. */}
            <p className={`login-message login-message--${message.tone}`} role="status">
              {message.text}
            </p>
          </form>
        </div>
      </section>
    </main>
  );
}
