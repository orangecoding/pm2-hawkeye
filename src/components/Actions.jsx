/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState } from 'react';
import { fetchWithCsrf } from '../services/api.js';
import { CheckCircle, WarningCircle } from './Icon.jsx';

/**
 * Read an action's name whether the backend sent a string or an object.
 *
 * @param {string|{name: string}} action
 * @returns {string}
 */
function actionName(action) {
  return typeof action === 'object' ? action.name : action;
}

/**
 * PM2 custom actions (axm_actions) for the selected process.
 *
 * Each action is its own row with its own trigger. The previous design hid
 * them all inside a single <select>: picking an option immediately armed a
 * confirmation, which made a dropdown behave like a button and gave no way to
 * see what an action was without selecting it.
 *
 * @param {{
 *   actions: (string|object)[],
 *   selectedProcessId: string | null,
 *   csrfToken: string | null,
 *   onCsrfRefresh: () => Promise<string>,
 * }} props
 */
export default function Actions({ actions, selectedProcessId, csrfToken, onCsrfRefresh }) {
  /** @type {[string|null, React.Dispatch<string|null>]} name of the action being armed */
  const [arming, setArming] = useState(null);
  const [params, setParams] = useState('');
  const [busy, setBusy] = useState(false);
  /** @type {[{ok: boolean, text: string}|null, React.Dispatch<object|null>]} */
  const [result, setResult] = useState(null);

  if (actions.length === 0) return null;

  /**
   * Trigger the armed action on the backend.
   *
   * @param {string} name
   * @param {boolean} requiresParams
   */
  async function trigger(name, requiresParams) {
    if (selectedProcessId == null || !csrfToken) return;
    setBusy(true);
    setResult(null);
    try {
      const body = { actionName: name };
      if (requiresParams && params.trim()) body.params = params.trim();
      await fetchWithCsrf(`/api/processes/${encodeURIComponent(selectedProcessId)}/actions/trigger`, {
        onCsrfRefresh,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setResult({ ok: true, text: `${name} triggered.` });
    } catch (err) {
      setResult({ ok: false, text: err.message ?? `${name} failed.` });
    } finally {
      setBusy(false);
      setArming(null);
      setParams('');
    }
  }

  return (
    <>
      <div className="action-list">
        {actions.map((action) => {
          const name = actionName(action);
          const requiresParams = typeof action === 'object' && Array.isArray(action.params) && action.params.length > 0;
          const isArmed = arming === name;

          return (
            <div className="action-row" key={name}>
              {isArmed ? (
                <div className="action-row-form">
                  <span className="action-row-name">{name}</span>
                  {requiresParams && (
                    <input
                      className="input"
                      type="text"
                      value={params}
                      placeholder="Parameters"
                      aria-label={`Parameters for ${name}`}
                      disabled={busy}
                      onChange={(e) => setParams(e.target.value)}
                    />
                  )}
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    onClick={() => trigger(name, requiresParams)}
                  >
                    {busy ? 'Running' : 'Run'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--quiet"
                    disabled={busy}
                    onClick={() => {
                      setArming(null);
                      setParams('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span className="action-row-name">{name}</span>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setArming(name);
                      setParams('');
                      setResult(null);
                    }}
                  >
                    Run
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {result && (
        <div className="action-result" data-ok={result.ok}>
          {result.ok ? <CheckCircle size={13} weight="fill" /> : <WarningCircle size={13} weight="fill" />}
          <span>{result.text}</span>
        </div>
      )}
    </>
  );
}
