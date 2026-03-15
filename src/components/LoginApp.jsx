/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useRef, useState } from "react";

export default function LoginApp() {
  const [message, setMessage] = useState("Authentication is required.");
  const [messageTone, setMessageTone] = useState("muted");
  const [submitting, setSubmitting] = useState(false);
  const usernameRef = useRef(null);
  const passwordRef = useRef(null);

  const showMessage = (text, tone = "muted") => {
    setMessage(text);
    setMessageTone(tone);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const username = usernameRef.current.value.trim();
    const password = passwordRef.current.value;

    if (!username || !password) {
      showMessage("Both fields are required.", "error");
      return;
    }

    setSubmitting(true);
    showMessage("Authenticating...", "muted");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const retryAfter = payload?.retryAfterSeconds
          ? ` Try again in about ${payload.retryAfterSeconds} second(s).`
          : "";
        throw new Error((payload.error || "Sign-in failed.") + retryAfter);
      }

      showMessage("Authentication successful. Redirecting...", "success");
      window.location.replace("/");
    } catch (err) {
      showMessage(err.message, "error");
      passwordRef.current?.focus();
      passwordRef.current?.select();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-card">
          <p className="eyebrow">Login</p>
          <h1>PM2 Command Center</h1>
          <p className="subtle">
            A modern, secure, and lightweight web dashboard for monitoring and managing PM2 processes.
          </p>
        </div>
        <section className="login-card">
          <p className="eyebrow">Authentication</p>
          <h2>Sign in</h2>
          <p className="subtle">Enter your administrator credentials to continue.</p>
          <form className="login-form" noValidate onSubmit={handleSubmit}>
            <label className="field">
              <span>Username</span>
              <input
                ref={usernameRef}
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck="false"
                autoFocus
                required
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                ref={passwordRef}
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button className="primary-button login-submit" type="submit" disabled={submitting}>
              {submitting ? "Signing in..." : "Sign in"}
            </button>
            <p className={`form-message ${messageTone}`}>{message}</p>
          </form>
        </section>
      </section>
    </main>
  );
}
