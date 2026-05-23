/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState } from 'react';
import Actions from './Actions.jsx';

/**
 * Compact process header bar.
 *
 * Renders a single-row header with status dot (9px), process name, optional
 * alerting badge, sub-line (status, PID, script path), and action buttons
 * (Stop/Restart, Delete). Keep the Actions component for custom PM2 actions.
 *
 * @param {{
 *   selectedProcess: object | null,
 *   details: object | null,
 *   onRestart: () => Promise<void>,
 *   onDelete: (withDeploy?: boolean) => Promise<void>,
 *   onRemoveOrphan: (pm2Name: string) => Promise<void>,
 *   selectedDeployment: object | null,
 *   actions: object[],
 *   selectedProcessId: string | null,
 *   csrfToken: string | null,
 *   onCsrfRefresh: () => Promise<string>,
 * }} props
 */
export default function HeroCard({
  selectedProcess,
  details,
  onRestart,
  onDelete,
  onRemoveOrphan,
  selectedDeployment,
  actions,
  selectedProcessId,
  csrfToken,
  onCsrfRefresh,
}) {
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRemoveOrphan, setConfirmingRemoveOrphan] = useState(false);

  const isOrphan = selectedProcess?.isOrphan ?? false;
  const status = selectedProcess?.status ?? '';
  const statusLower = status.toLowerCase();
  const isDeletable = !isOrphan && selectedProcess &&
    ['stopped', 'errored', 'error', 'one-launch-status'].includes(statusLower);

  if (!selectedProcess) {
    return (
      <header className="hero-card">
        <div className="hero-empty">
          <p className="hero-empty-hint">Select a process from the sidebar</p>
        </div>
      </header>
    );
  }

  const pid = details?.process?.pid;
  const script = selectedProcess?.pm2_env?.pm_exec_path ?? selectedProcess?.script ?? '';
  const scriptShort = script.split('/').pop() || script;

  return (
    <header className="hero-card">
      <div className="hero-header-row">
        <span className="hero-status-dot" data-status={statusLower} />
        <h1 className="hero-process-name">{selectedProcess.name}</h1>
        {selectedProcess.alertsEnabled !== false && selectedProcess.isMonitored && (
          <span className="hero-alert-badge">alert</span>
        )}
        <div className="hero-subline">
          <span className="hero-status-text" data-status={statusLower}>{status}</span>
          {pid != null && <span className="hero-meta">PID {pid}</span>}
          {scriptShort && <span className="hero-meta">{scriptShort}</span>}
        </div>
        <div className="hero-action-btns">
          {confirmingRestart ? (
            <span className="hero-confirm">
              Restart?
              <button className="hero-confirm-btn hero-confirm-btn--yes" onClick={async () => { setConfirmingRestart(false); await onRestart(); }}>Yes</button>
              <button className="hero-confirm-btn" onClick={() => setConfirmingRestart(false)}>No</button>
            </span>
          ) : (
            <button
              className="ghost-button"
              type="button"
              disabled={!selectedProcess}
              onClick={() => setConfirmingRestart(true)}
            >
              Restart
            </button>
          )}
          {isOrphan && (
            confirmingRemoveOrphan ? (
              <span className="hero-confirm">
                Remove orphan?
                <button className="hero-confirm-btn hero-confirm-btn--yes" onClick={async () => { setConfirmingRemoveOrphan(false); await onRemoveOrphan(selectedProcess.name); }}>Yes</button>
                <button className="hero-confirm-btn" onClick={() => setConfirmingRemoveOrphan(false)}>No</button>
              </span>
            ) : (
              <button className="ghost-button danger-button" type="button" onClick={() => setConfirmingRemoveOrphan(true)}>Remove orphan</button>
            )
          )}
          {isDeletable && (
            confirmingDelete ? (
              <span className="hero-confirm">
                Delete from PM2?
                {selectedDeployment ? (
                  <>
                    <button className="hero-confirm-btn hero-confirm-btn--yes" onClick={async () => { setConfirmingDelete(false); await onDelete(true); }}>Yes, incl. disk</button>
                    <button className="hero-confirm-btn hero-confirm-btn--yes" onClick={async () => { setConfirmingDelete(false); await onDelete(false); }}>PM2 only</button>
                  </>
                ) : (
                  <button className="hero-confirm-btn hero-confirm-btn--yes" onClick={async () => { setConfirmingDelete(false); await onDelete(false); }}>Yes</button>
                )}
                <button className="hero-confirm-btn" onClick={() => setConfirmingDelete(false)}>No</button>
              </span>
            ) : (
              <button className="ghost-button danger-button" type="button" onClick={() => setConfirmingDelete(true)}>Delete</button>
            )
          )}
        </div>
      </div>
      {actions.length > 0 && (
        <Actions
          actions={actions}
          selectedProcessId={selectedProcessId}
          csrfToken={csrfToken}
          onCsrfRefresh={onCsrfRefresh}
        />
      )}
    </header>
  );
}
