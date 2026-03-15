/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, {useState} from "react";
import Pill from "./Pill.jsx";
import { formatBytes, formatDate, getStatusTone } from "../services/format.js";
import Actions from "./Actions.jsx";

export default function HeroCard({ selectedProcess, details, sseConnected, onLogout, onRestart, actions, selectedProcessId, csrfToken, onCsrfRefresh }) {
  const [confirmingRestart, setConfirmingRestart] = useState(false);

  const handleRestartClick = () => {
    setConfirmingRestart(true);
  };

  const handleRestartConfirm = async () => {
    setConfirmingRestart(false);
    await onRestart();
  };

  const handleRestartCancel = () => {
    setConfirmingRestart(false);
  };

  return (
    <header className="hero-card section-shell">
      <div className="hero-copy">
        <p className="eyebrow">Selected Process</p>
        <h2>{selectedProcess?.name || "No process selected"}</h2>
        <p className="subtle">
          {selectedProcess
            ? `Status: ${selectedProcess.status} · PID: ${details?.process?.pid ?? "n/a"} · Up since: ${details?.process?.uptime ? formatDate(details.process.uptime) : ""}`
            : "Choose a PM2 process from the sidebar."}
        </p>
        <div className="selection-badges">
          {selectedProcess ? (
            <>
              <Pill label={selectedProcess.status || "unknown"} tone={getStatusTone(selectedProcess.status)} />
              <Pill label={`${selectedProcess.cpu}% CPU`} tone="neutral" />
              <Pill label={formatBytes(selectedProcess.memory)} tone="neutral" />
            </>
          ) : (
            <Pill label="Waiting for selection" tone="muted" />
          )}
        </div>
      </div>
      <div className="hero-rail">
        <div className="signal-card">
          <span className={`signal-dot ${sseConnected ? "connected" : "disconnected"}`} />
          <div>
            <span className="signal-label">Live stream</span>
            <strong>{sseConnected ? "Connected" : "Disconnected"}</strong>
          </div>
        </div>
        <div className="hero-actions">
          {confirmingRestart ? (
            <div className="action-confirm">
              <span>Restart <strong>{selectedProcess?.name}</strong>?</span>
              <div className="action-confirm-buttons">
                <button className="btn btn-sm btn-confirm" onClick={handleRestartConfirm}>Yes</button>
                <button className="btn btn-sm btn-cancel" onClick={handleRestartCancel}>No</button>
              </div>
            </div>
          ) : (
            <button className="primary-button" type="button" disabled={!selectedProcess} onClick={handleRestartClick}>Restart process</button>
          )}
          <button className="ghost-button" type="button" onClick={onLogout}>Sign out</button>
        </div>
        <Actions
            actions={actions}
            selectedProcessId={selectedProcessId}
            csrfToken={csrfToken}
            onCsrfRefresh={onCsrfRefresh}
        />
      </div>
    </header>
  );
}
