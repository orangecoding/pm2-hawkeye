/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useState } from 'react';
import { fetchJson, fetchWithCsrf } from '../../services/api.js';
import { copyText } from '../../services/clipboard.js';
import {
  maskKey,
  buildCliSnippet,
  buildJsonSnippet,
  buildExportLine,
  groupTools,
  isPlainHttpRemote,
} from '../../services/mcp.js';
import ConfirmButton from '../ConfirmButton.jsx';
import { ArrowClockwise, Check, Copy, Eye, EyeSlash, Info, Warning } from '../Icon.jsx';

const SNIPPET_TABS = [
  { id: 'cli', label: 'Command line' },
  { id: 'json', label: '.mcp.json' },
];

/** How long a copy button shows its result before it resets. */
const COPY_FEEDBACK_MS = 1600;

/**
 * Copy button with its own short-lived "Copied" state.
 *
 * @param {{ text: string, label: string, iconOnly?: boolean }} props - `label`
 *   is the accessible name; the icon-only variant shows no text.
 */
function CopyButton({ text, label, iconOnly = false }) {
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!result) return undefined;
    const timer = setTimeout(() => setResult(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [result]);

  async function copy() {
    setResult((await copyText(text)) ? 'copied' : 'failed');
  }

  const icon = result === 'copied' ? <Check size={iconOnly ? 15 : 13} /> : <Copy size={iconOnly ? 15 : 13} />;
  const state = result ? ` mcp-copy--${result}` : '';

  if (iconOnly) {
    return (
      <button
        type="button"
        className={`btn btn--icon mcp-copy${state}`}
        aria-label={label}
        title={label}
        onClick={copy}
      >
        {icon}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`btn btn--sm mcp-copy mcp-copy--overlay${state}`}
      aria-label={label}
      onClick={copy}
    >
      {icon}
      {result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

/**
 * Toggle switch in the app's `.toggle` markup.
 *
 * @param {{ checked: boolean, onChange: (checked: boolean) => void, label: string, text?: string, disabled?: boolean }} props
 *   `label` is the accessible name, `text` an optional visible state label.
 */
function Toggle({ checked, onChange, label, text, disabled = false }) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
      {text && <span className="toggle-label">{text}</span>}
    </label>
  );
}

/**
 * Settings page of the MCP server: the on/off switch, the access key, the
 * Claude Code snippet and one switch per tool. Every change is saved at once.
 *
 * @param {{ csrfToken: string | null, onCsrfRefresh: () => Promise<string> }} props
 */
export default function McpSettings({ csrfToken, onCsrfRefresh }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [tab, setTab] = useState('cli');

  useEffect(() => {
    fetchJson('/api/mcp/settings')
      .then(setSettings)
      .catch((err) => setNotice({ type: 'error', text: `Failed to load MCP settings: ${err.message}` }))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Send a change and take the server's answer as the new state. The change
   * is shown at once and rolled back when the server refuses it.
   *
   * @param {string} url
   * @param {object} body
   * @param {object} optimistic - Settings to show while the request runs.
   * @returns {Promise<boolean>} True when the server accepted the change.
   */
  async function save(url, body, optimistic) {
    const previous = settings;
    setNotice(null);
    setSettings(optimistic);
    try {
      const next = await fetchWithCsrf(url, {
        onCsrfRefresh,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSettings(next);
      return true;
    } catch (err) {
      setSettings(previous);
      setNotice({ type: 'error', text: err.message ?? 'Save failed.' });
      return false;
    }
  }

  /** @param {boolean} enabled */
  function setServerEnabled(enabled) {
    save('/api/mcp/settings', { enabled }, { ...settings, enabled });
  }

  /** @param {Record<string, boolean>} changes - Tool name -> wanted state. */
  function setTools(changes) {
    const tools = settings.tools.map((tool) =>
      tool.name in changes ? { ...tool, enabled: changes[tool.name] } : tool,
    );
    save('/api/mcp/settings', { tools: changes }, { ...settings, tools });
  }

  async function rotateKey() {
    if (await save('/api/mcp/key/rotate', {}, settings)) {
      setRevealed(true);
      setNotice({
        type: 'success',
        text: 'New key created. Clients that still use the old key are refused until you update them with the snippet below.',
      });
    }
  }

  if (loading) {
    return (
      <div className="settings-page">
        <div className="settings-skeleton" />
        <div className="settings-skeleton" />
        <div className="settings-skeleton" />
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="settings-page">
        {notice && <div className={`settings-notice settings-notice--${notice.type}`}>{notice.text}</div>}
      </div>
    );
  }

  const disabled = !csrfToken;
  const url = `${window.location.origin}/mcp`;
  const key = settings.key ?? '';
  const shownKey = revealed ? key : maskKey(key);
  const groups = groupTools(settings.tools);
  const enabledCount = settings.tools.filter((tool) => tool.enabled).length;

  return (
    <div className="settings-page mcp-page">
      {notice && (
        <div
          className={`settings-notice settings-notice--${notice.type}`}
          role={notice.type === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </div>
      )}

      <section className="settings-group" aria-labelledby="mcp-server-title">
        <div className="reporter-head">
          <h3 id="mcp-server-title" className="settings-group-title">
            Server
          </h3>
          <Toggle
            checked={settings.enabled}
            onChange={setServerEnabled}
            label="MCP server enabled"
            text={settings.enabled ? 'Enabled' : 'Disabled'}
            disabled={disabled}
          />
        </div>
        <p className="subtle mcp-lead">
          Lets AI agents such as Claude Code read and control your PM2 processes through Hawkeye. Agents connect to the
          endpoint below and sign in with the access key.
        </p>

        {settings.enabled ? (
          <>
            <div className="field">
              <div className="mcp-field-head">
                <label htmlFor="mcp-endpoint">Endpoint</label>
                <span className="mcp-status">
                  <span className="status-dot" data-status="online" />
                  <span className="status-text" data-status="online">
                    Accepting connections
                  </span>
                </span>
              </div>
              <div className="mcp-input-row">
                <input id="mcp-endpoint" className="input mcp-mono" type="text" readOnly value={url} />
                <CopyButton text={url} label="Copy endpoint" iconOnly />
              </div>
            </div>

            <div className="callout callout--warning callout--row">
              <Warning className="callout-icon" size={15} />
              <p className="callout-body callout-text mcp-callout-text">
                <strong>The key is as strong as your password.</strong> An agent with it can do everything the enabled
                tools allow. With the deploy tools on, that includes running code on this server.
              </p>
            </div>
          </>
        ) : (
          <div className="callout callout--stack">
            <p className="callout-title">The MCP server is off.</p>
            <p className="callout-text">
              Hawkeye answers <code>/mcp</code> with 404 and accepts no key.
            </p>
            <p className="callout-text">
              {settings.key
                ? 'Your access key and tool choices stay as they are when you turn the server back on.'
                : 'Turning it on creates an access key and enables the read tools. Tools that change or delete something stay off until you turn them on one by one.'}
            </p>
          </div>
        )}
      </section>

      {settings.enabled && (
        <>
          <section className="settings-group" aria-labelledby="mcp-key-title">
            <h3 id="mcp-key-title" className="settings-group-title">
              Access key
            </h3>
            <div className="field">
              <label htmlFor="mcp-key">Key</label>
              <div className="mcp-input-row">
                <input id="mcp-key" className="input mcp-mono" type="text" readOnly value={shownKey} />
                <button
                  type="button"
                  className="btn btn--icon"
                  aria-label={revealed ? 'Hide key' : 'Show key'}
                  title={revealed ? 'Hide key' : 'Show key'}
                  aria-pressed={revealed}
                  onClick={() => setRevealed((value) => !value)}
                >
                  {revealed ? <EyeSlash size={15} /> : <Eye size={15} />}
                </button>
                <CopyButton text={key} label="Copy key" iconOnly />
              </div>
              <p className="hint">
                Stored on this server. The eye also unmasks the key in the snippet below. Copy always copies the full
                key.
              </p>
            </div>
            <div>
              <ConfirmButton
                label="Rotate key"
                icon={<ArrowClockwise size={14} />}
                question="Rotate the key? Clients using the old one stop working."
                choices={[{ label: 'Rotate', danger: true, onConfirm: rotateKey }]}
                disabled={disabled}
              />
            </div>
          </section>

          <section className="settings-group" aria-labelledby="mcp-connect-title">
            <h3 id="mcp-connect-title" className="settings-group-title">
              Connect Claude Code
            </h3>
            <div className="segmented mcp-tabs" role="group" aria-label="Snippet format">
              {SNIPPET_TABS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="segmented-item"
                  aria-pressed={tab === option.id}
                  onClick={() => setTab(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {tab === 'cli' ? (
              <>
                <p className="subtle mcp-lead">
                  Run once in a terminal on the machine where you use Claude Code. <code>--scope user</code> makes
                  Hawkeye available in every project.
                </p>
                <div className="mcp-snippet">
                  <pre className="code-preview">{buildCliSnippet(url, shownKey)}</pre>
                  <CopyButton text={buildCliSnippet(url, key)} label="Copy command" />
                </div>
              </>
            ) : (
              <>
                <p className="subtle mcp-lead">
                  Put this in <code>.mcp.json</code> at a project root to share the server with that project. Claude
                  Code reads the key from the environment, so it never lands in the repository.
                </p>
                <div className="mcp-snippet">
                  <pre className="code-preview">{buildJsonSnippet(url)}</pre>
                  <CopyButton text={buildJsonSnippet(url)} label="Copy .mcp.json" />
                </div>
                <p className="subtle mcp-lead">
                  Set the key in the shell that starts Claude Code, for example in <code>~/.zshrc</code>:
                </p>
                <div className="mcp-snippet">
                  <pre className="code-preview">{buildExportLine(shownKey)}</pre>
                  <CopyButton text={buildExportLine(key)} label="Copy export line" />
                </div>
              </>
            )}

            <p className="hint">
              Check the connection with <code>claude mcp list</code>. Hawkeye should show as connected.
            </p>
            {isPlainHttpRemote(window.location) && (
              <p className="hint mcp-tls-hint">
                <Info size={14} />
                <span>
                  You opened Hawkeye over plain HTTP, so the key travels unencrypted. Put Hawkeye behind a reverse proxy
                  with TLS before connecting from another machine.
                </span>
              </p>
            )}
          </section>

          <section className="settings-group" aria-labelledby="mcp-tools-title">
            <div className="reporter-head">
              <h3 id="mcp-tools-title" className="settings-group-title">
                Tools
              </h3>
              <span className="num mcp-count">
                {enabledCount} of {settings.tools.length} on
              </span>
            </div>
            <p className="hint">
              A tool that is off is hidden from agents and cannot be called. Changes apply to the next request, no
              restart.
            </p>

            {groups.map(({ group, tools, enabledCount: groupOn }) => {
              const allOn = groupOn === tools.length;
              return (
                <div key={group.access} className="mcp-tool-group">
                  <div className="mcp-tool-group-head">
                    <div className="mcp-tool-group-text">
                      <div className="mcp-tool-group-title">
                        <h4>{group.label}</h4>
                        {group.tag && <span className={`tag tag--${group.tag.tone}`}>{group.tag.label}</span>}
                      </div>
                      <p className="hint">{group.description}</p>
                    </div>
                    <div className="mcp-tool-group-actions">
                      <span className="num mcp-count">
                        {groupOn} / {tools.length}
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm btn--quiet"
                        disabled={disabled}
                        onClick={() => setTools(Object.fromEntries(tools.map((tool) => [tool.name, !allOn])))}
                      >
                        {allOn ? 'Turn all off' : 'Turn all on'}
                      </button>
                    </div>
                  </div>
                  <ul className="mcp-tool-list">
                    {tools.map((tool) => (
                      <li key={tool.name} className="mcp-tool">
                        <div className="mcp-tool-text">
                          <div className="mcp-tool-name-row">
                            <code className="mcp-tool-name" data-enabled={tool.enabled}>
                              {tool.name}
                            </code>
                            {tool.runsCode && <span className="tag tag--warning">runs code</span>}
                          </div>
                          <span className="hint">{tool.summary}</span>
                        </div>
                        <Toggle
                          checked={tool.enabled}
                          onChange={(checked) => setTools({ [tool.name]: checked })}
                          label={`Enable ${tool.name}`}
                          disabled={disabled}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
