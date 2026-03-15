/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import {fetchJson} from "../services/api.js";
import React, {useState} from "react";

export default function Actions({actions, selectedProcessId, csrfToken, onCsrfRefresh}) {

    const [selectedAction, setSelectedAction] = useState("");
    const [confirming, setConfirming] = useState(false);
    const [triggering, setTriggering] = useState(false);
    const [successMsg, setSuccessMsg] = useState("");
    const [actionParams, setActionParams] = useState("");

    // Find the selected action's metadata to check if it requires params
    const selectedActionMeta = actions.find((a) => (typeof a === "object" ? a.name : a) === selectedAction);
    const actionRequiresParams = selectedActionMeta && typeof selectedActionMeta === "object" && selectedActionMeta.params && selectedActionMeta.params.length > 0;

    const handleActionSelect = (e) => {
        setSelectedAction(e.target.value);
        setActionParams("");
        if (e.target.value) {
            setConfirming(true);
        }
    };

    const handleConfirm = async () => {
        if (!selectedAction || selectedProcessId == null || !csrfToken) {
            return;
        }
        setTriggering(true);
        try {
            const body = {actionName: selectedAction};
            if (actionRequiresParams && actionParams.trim()) {
                body.params = actionParams.trim();
            }
            await fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/actions/trigger`, {
                method: "POST",
                headers: {"Content-Type": "application/json", "X-CSRF-Token": csrfToken},
                body: JSON.stringify(body),
            });
            if (onCsrfRefresh) await onCsrfRefresh();
            setSuccessMsg(`Action "${selectedAction}" triggered successfully.`);
            setTimeout(() => setSuccessMsg(""), 3500);
        } catch {
            // Errors are handled by fetchJson
        } finally {
            setTriggering(false);
            setConfirming(false);
            setSelectedAction("");
            setActionParams("");
        }
    };

    const handleCancel = () => {
        setConfirming(false);
        setSelectedAction("");
        setActionParams("");
    };

    if (actions.length === 0) return null;

    return (
        <div className="actions-dropdown">
            <p className="eyebrow actions-eyebrow">Trigger Actions</p>
            {successMsg && <div className="action-success">{successMsg}</div>}
            {confirming ? (
                <div className="action-confirm">
                    <span>Trigger <strong>{selectedAction}</strong>?</span>
                    {actionRequiresParams && (
                        <input
                            type="text"
                            className="action-param-input"
                            placeholder="Parameters…"
                            value={actionParams}
                            onChange={(e) => setActionParams(e.target.value)}
                            disabled={triggering}
                        />
                    )}
                    <div className="action-confirm-buttons">
                        <button className="btn btn-sm btn-confirm" onClick={handleConfirm} disabled={triggering}>
                            {triggering ? "Triggering…" : "Yes"}
                        </button>
                        <button className="btn btn-sm btn-cancel" onClick={handleCancel} disabled={triggering}>No</button>
                    </div>
                </div>
            ) : (
                <select value={selectedAction} onChange={handleActionSelect} className="action-select">
                    <option value="">PM2 Actions…</option>
                    {actions.map((action) => {
                        const name = typeof action === "object" ? action.name : action;
                        return <option key={name} value={name}>{name}</option>;
                    })}
                </select>
            )}
        </div>);
}