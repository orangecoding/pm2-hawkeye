/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState } from 'react';
import { fetchWithCsrf } from '../services/api.js';
import ConfirmButton from './ConfirmButton.jsx';
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
 * PM2 custom actions (axm_actions) for the selected process, as rows of the
 * Custom actions card.
 *
 * Each action is its own row: its name, a parameter input when the action
 * takes parameters, and a Run button that asks once before it triggers, like
 * every other action that changes a process. The outcome of the last run
 * shows below the rows.
 *
 * @param {{
 *   actions: (string|object)[],
 *   selectedProcessId: string | null,
 *   csrfToken: string | null,
 *   onCsrfRefresh: () => Promise<string>,
 * }} props
 */
export default function Actions({ actions, selectedProcessId, csrfToken, onCsrfRefresh }) {
  /** @type {[Record<string, string>, React.Dispatch<Record<string, string>>]} parameter text per action name */
  const [params, setParams] = useState({});
  /** @type {[{ok: boolean, name: string, text: string}|null, React.Dispatch<object|null>]} */
  const [result, setResult] = useState(null);

  if (actions.length === 0) return null;

  /**
   * Trigger an action on the backend.
   *
   * @param {string} name
   * @param {boolean} requiresParams
   */
  async function trigger(name, requiresParams) {
    if (selectedProcessId == null || !csrfToken) return;
    setResult(null);
    try {
      const body = { actionName: name };
      const value = (params[name] ?? '').trim();
      if (requiresParams && value) body.params = value;
      await fetchWithCsrf(`/api/processes/${encodeURIComponent(selectedProcessId)}/actions/trigger`, {
        onCsrfRefresh,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setResult({ ok: true, name, text: 'triggered.' });
      setParams((prev) => ({ ...prev, [name]: '' }));
    } catch (err) {
      setResult({ ok: false, name, text: err.message ? `failed: ${err.message}` : 'failed.' });
    }
  }

  return (
    <>
      {actions.map((action) => {
        const name = actionName(action);
        const requiresParams = typeof action === 'object' && Array.isArray(action.params) && action.params.length > 0;
        return (
          <div className="action-row" key={name}>
            <span className="action-row-name">{name}</span>
            {requiresParams && (
              <input
                className="input action-row-input"
                type="text"
                value={params[name] ?? ''}
                placeholder="parameter"
                aria-label={`Parameter for ${name}`}
                onChange={(e) => setParams((prev) => ({ ...prev, [name]: e.target.value }))}
              />
            )}
            <ConfirmButton
              label="Run"
              question={`Run ${name}?`}
              size="sm"
              className="btn--sunken"
              choices={[{ label: 'Run', onConfirm: () => trigger(name, requiresParams) }]}
            />
          </div>
        );
      })}

      {result && (
        <div className="action-result action-result--card" data-ok={result.ok}>
          {result.ok ? <CheckCircle size={13} weight="fill" /> : <WarningCircle size={13} weight="fill" />}
          <span>
            <span className="num">{result.name}</span> {result.text}
          </span>
        </div>
      )}
    </>
  );
}
