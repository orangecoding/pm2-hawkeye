/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState } from 'react';

/**
 * A button that asks once before it acts.
 *
 * This is the app's single confirmation idiom. Every destructive or disruptive
 * action uses it, so the interaction is identical whether the user is
 * restarting a process, disabling monitoring, or deleting a deployment.
 *
 * Pass more than one entry in `choices` when the action has variants (for
 * example deleting from PM2 only versus deleting from PM2 and disk).
 *
 * @param {{
 *   label: string,
 *   question: string,
 *   choices?: { label: string, onConfirm: () => void | Promise<void>, danger?: boolean }[],
 *   onConfirm?: () => void | Promise<void>,
 *   variant?: 'default' | 'primary' | 'danger',
 *   size?: 'default' | 'sm',
 *   disabled?: boolean,
 * }} props
 */
export default function ConfirmButton({
  label,
  question,
  choices,
  onConfirm,
  variant = 'default',
  size = 'default',
  disabled = false,
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const options = choices ?? [{ label: 'Confirm', onConfirm, danger: variant === 'danger' }];

  /**
   * Run a choice's handler, then close the prompt.
   *
   * @param {{ onConfirm?: () => void | Promise<void> }} choice
   */
  async function run(choice) {
    setBusy(true);
    try {
      await choice.onConfirm?.();
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }

  const sizeClass = size === 'sm' ? ' btn--sm' : '';

  if (!asking) {
    return (
      <button
        type="button"
        className={`btn${variant === 'danger' ? ' btn--danger' : variant === 'primary' ? ' btn--primary' : ''}${sizeClass}`}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="confirm" role="group" aria-label={question}>
      <span className="confirm-label">{question}</span>
      <span className="confirm-actions">
        {options.map((choice) => (
          <button
            key={choice.label}
            type="button"
            className={`btn btn--sm${choice.danger ? ' btn--danger' : ' btn--primary'}`}
            disabled={busy}
            onClick={() => run(choice)}
          >
            {choice.label}
          </button>
        ))}
        <button type="button" className="btn btn--sm btn--quiet" disabled={busy} onClick={() => setAsking(false)}>
          Cancel
        </button>
      </span>
    </span>
  );
}
