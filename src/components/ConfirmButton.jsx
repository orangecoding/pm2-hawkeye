/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useRef, useState } from 'react';

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
 * The trigger is swapped for the prompt in place, so focus is managed by hand:
 * opening the prompt focuses Cancel (the safe answer, inside a group labelled
 * with the question so screen readers announce it), Escape cancels, and
 * closing the prompt puts focus back on the trigger.
 *
 * @param {{
 *   label: string,
 *   question: string,
 *   choices: { label: string, onConfirm: () => void | Promise<void>, danger?: boolean }[],
 *   variant?: 'default' | 'danger',
 *   size?: 'default' | 'sm',
 * }} props
 */
export default function ConfirmButton({ label, question, choices, variant = 'default', size = 'default' }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef(null);
  const cancelRef = useRef(null);
  /** Set when the prompt closes, so the remounted trigger takes focus back. */
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (asking) {
      cancelRef.current?.focus();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [asking]);

  /** Close the prompt and hand focus back to the trigger. */
  function close() {
    restoreFocusRef.current = true;
    setAsking(false);
  }

  /**
   * Run a choice's handler, then close the prompt.
   *
   * @param {{ onConfirm: () => void | Promise<void> }} choice
   */
  async function run(choice) {
    setBusy(true);
    try {
      await choice.onConfirm();
    } finally {
      setBusy(false);
      close();
    }
  }

  const sizeClass = size === 'sm' ? ' btn--sm' : '';

  if (!asking) {
    return (
      <button
        ref={triggerRef}
        type="button"
        className={`btn${variant === 'danger' ? ' btn--danger' : ''}${sizeClass}`}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span
      className="confirm"
      role="group"
      aria-label={question}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          // Keep an enclosing dialog from closing on the same key press.
          e.stopPropagation();
          close();
        }
      }}
    >
      <span className="confirm-label">{question}</span>
      <span className="confirm-actions">
        {choices.map((choice) => (
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
        <button ref={cancelRef} type="button" className="btn btn--sm btn--quiet" disabled={busy} onClick={close}>
          Cancel
        </button>
      </span>
    </span>
  );
}
