/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { fetchJson } from "../services/api.js";

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Polls `/api/update` once on mount. If a newer version is available it
 * renders an unobtrusive pill in the bottom-right corner. Clicking the pill
 * opens a slide-up panel containing the formatted release notes.
 */
export default function UpdateBanner() {
  const [update, setUpdate]     = useState(null);
  const [open, setOpen]         = useState(false);
  const [dismissed, setDismiss] = useState(false);
  const panelRef                = useRef(null);

  // Fetch once on mount; no interval — the backend does the polling.
  useEffect(() => {
    fetchJson("/api/update")
      .then(({ update: info }) => {
        if (info) setUpdate(info);
      })
      .catch(() => {}); // non-critical
  }, []);

  // Close panel on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  if (!update || dismissed) return null;

  const published = update.publishedAt
    ? new Date(update.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;

  return (
    <div className="update-root" ref={panelRef}>
      {/* Pill trigger */}
      <button
        className="update-pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="New version available"
      >
        <span className="update-dot" />
        <span>v{update.latestVersion} available</span>
      </button>

      {/* Release notes panel */}
      {open && (
        <div className="update-panel" role="dialog" aria-modal="true" aria-label="Release notes">
          <div className="update-panel-header">
            <div className="update-panel-title">
              <span className="update-panel-tag">v{update.latestVersion}</span>
            </div>
            <div className="update-panel-meta">
              {published && <span className="update-panel-date">{published}</span>}
              <a
                className="update-panel-link"
                href={update.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on GitHub ↗
              </a>
            </div>
          </div>

          <div className="update-panel-body">
            {update.releaseNotes
              ? (
                <Markdown
                  components={{
                    // Open all links in a new tab safely
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                    ),
                    // Map h2/h3 down to h4/h5 so they fit the panel's visual hierarchy
                    h2: ({ children }) => <h4>{children}</h4>,
                    h3: ({ children }) => <h5>{children}</h5>,
                  }}
                >
                  {update.releaseNotes}
                </Markdown>
              )
              : <p className="update-empty">No release notes provided.</p>
            }
          </div>

          <div className="update-panel-footer">
            <button className="update-dismiss" onClick={() => { setDismiss(true); setOpen(false); }}>
              Dismiss
            </button>
            <a
              className="btn btn-primary update-cta"
              href={update.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              See release on GitHub
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
