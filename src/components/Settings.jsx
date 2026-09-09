/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, fetchWithCsrf } from '../services/api.js';
import { useDialogFocus } from '../services/dialog.js';
import GeneralSettings from './settings/GeneralSettings.jsx';
import AlertingSettings from './settings/AlertingSettings.jsx';
import { X } from './Icon.jsx';

const PAGES = [
  { id: 'General', label: 'General', desc: 'Server, sign in, retention' },
  { id: 'Alerting', label: 'Alerting', desc: 'When and where to notify' },
];

/**
 * Settings overlay.
 *
 * Closes on Escape or a backdrop click. Unsaved alerting changes are surfaced
 * in the dialog itself rather than through a native window.confirm(), which was
 * the only browser-chrome dialog left in the app and could not be styled or
 * dismissed consistently with everything else.
 *
 * @param {{
 *   onClose: () => void,
 *   csrfToken: string | null,
 *   onCsrfRefresh: () => Promise<void>,
 * }} props
 */
export default function Settings({ onClose, csrfToken, onCsrfRefresh }) {
  const [activePage, setActivePage] = useState('General');
  const [alertingSettings, setAlertingSettings] = useState({});
  const [alertingSettingsLoaded, setAlertingSettingsLoaded] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  /** True once the user has tried to close with unsaved alerting changes. */
  const [confirmingClose, setConfirmingClose] = useState(false);
  const modalRef = useRef(null);

  // Load alerting settings once on mount.
  useEffect(() => {
    fetchJson('/api/alerting/settings')
      .then((payload) => {
        setAlertingSettings(payload.settings ?? {});
        setAlertingSettingsLoaded(true);
      })
      .catch((loadError) => {
        setSaveError(`Failed to load alerting settings: ${loadError.message}`);
        setAlertingSettingsLoaded(true);
      });
  }, []);

  /**
   * Attempt to close. With unsaved alerting changes the first attempt arms an
   * in-dialog prompt instead of closing.
   */
  const handleClose = useCallback(() => {
    if (isDirty) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }, [isDirty, onClose]);

  useDialogFocus(modalRef, handleClose);

  /**
   * Handle alerting settings form changes.
   *
   * @param {Record<string, string>} updated
   */
  function handleAlertingChange(updated) {
    setAlertingSettings(updated);
    setIsDirty(true);
    setSaveSuccess(false);
  }

  /**
   * Save alerting settings to the backend.
   */
  async function handleAlertingSave() {
    if (!csrfToken) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await fetchWithCsrf('/api/alerting/settings', {
        onCsrfRefresh,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: alertingSettings }),
      });
      setIsDirty(false);
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err.message ?? 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Handle backdrop click - close only if clicking the backdrop itself.
   *
   * @param {React.MouseEvent} e
   */
  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) handleClose();
  }

  return (
    <div className="overlay" onClick={handleOverlayClick} role="dialog" aria-modal="true" aria-label="Settings">
      <div ref={modalRef} className="modal modal--settings" tabIndex={-1}>
        <nav className="settings-sidebar">
          <p className="section-label settings-sidebar-title">Settings</p>
          {PAGES.map((page) => (
            <button
              key={page.id}
              className={`settings-nav-item${activePage === page.id ? ' active' : ''}`}
              type="button"
              onClick={() => setActivePage(page.id)}
            >
              <span className="settings-nav-label">{page.label}</span>
              <span className="settings-nav-desc">{page.desc}</span>
            </button>
          ))}
        </nav>

        <div className="settings-main">
          <div className="modal-header">
            <span className="modal-title">{activePage}</span>
            {confirmingClose ? (
              <span className="confirm">
                <span className="confirm-label">Discard unsaved changes?</span>
                <span className="confirm-actions">
                  <button type="button" className="btn btn--sm btn--danger" onClick={onClose}>
                    Discard
                  </button>
                  <button type="button" className="btn btn--sm btn--quiet" onClick={() => setConfirmingClose(false)}>
                    Keep editing
                  </button>
                </span>
              </span>
            ) : (
              <button type="button" className="btn btn--icon" aria-label="Close settings" onClick={handleClose}>
                <X size={15} />
              </button>
            )}
          </div>

          <div className="settings-body">
            {saveSuccess && activePage === 'Alerting' && (
              <div className="settings-notice settings-notice--success">Alerting settings saved.</div>
            )}

            {activePage === 'General' && <GeneralSettings csrfToken={csrfToken} onCsrfRefresh={onCsrfRefresh} />}

            {activePage === 'Alerting' && alertingSettingsLoaded && (
              <AlertingSettings
                settings={alertingSettings}
                onChange={handleAlertingChange}
                onSave={handleAlertingSave}
                saving={saving}
                saveError={saveError}
                csrfToken={csrfToken}
                onCsrfRefresh={onCsrfRefresh}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
