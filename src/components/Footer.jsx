/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from "react";

/**
 * Sticky app footer — always visible at the bottom of the viewport.
 * Spans the full width of the grid (sidebar + content).
 *
 * @param {{ version: string|null }} props
 */
export default function Footer({ version }) {
  return (
    <footer className="app-footer">
      <span className="app-footer-version">
        pm2-manager{version && <> <strong>v{version}</strong></>}
      </span>
      <span className="app-footer-credit">
        Made with <span className="app-footer-heart">❤️</span> by{" "}
        <a href="https://github.com/orangecoding" target="_blank" rel="noopener noreferrer">
          Christian Kellner
        </a>
      </span>
    </footer>
  );
}
