/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {fetchJson} from "../services/api.js";
import ProcessList from "./ProcessList.jsx";
import HeroCard from "./HeroCard.jsx";
import StatsGrid from "./StatsGrid.jsx";
import LogStream from "./LogStream.jsx";
import MonitoringNotice from "./MonitoringNotice.jsx";
import UpdateBanner from "./UpdateBanner.jsx";
import Footer from "./Footer.jsx";
import Settings from "./Settings.jsx";
import DeployModal from "./DeployModal.jsx";

/**
 * Convert DB log entries (newest-first) to flat display lines (oldest-first).
 *
 * The `logLevel` field carries the level that was resolved on the backend at
 * insert time (text-based detection + stderr fallback), so the frontend does
 * not need to re-detect it.  'unknown' is normalised to '' to match the
 * frontend convention used by detectLogLevel.
 *
 * @param {object[]} entries - Raw entries from `/api/processes/:id/logs/stored`.
 * @returns {{text: string, source: string, logLevel: string}[]}
 */
function convertEntriesToLines(entries) {
    return entries
        .slice()
        .reverse()
        .flatMap((entry) => {
            const logLevel = entry.log_level || '';
            try {
                const parsed = JSON.parse(entry.log);
                return (parsed.lines || []).map((text) => ({text, source: 'stored', logLevel}));
            } catch {
                return [{text: entry.log, source: 'stored', logLevel}];
            }
        });
}

export default function App() {
    const [csrfToken, setCsrfToken] = useState(null);
    const [processes, setProcesses] = useState([]);
    const [selectedProcessId, setSelectedProcessId] = useState(null);
    const [details, setDetails] = useState(null);
    const [processListStatus, setProcessListStatus] = useState("Loading processes…");
    const [error, setError] = useState("");
    const [wsConnected, setWsConnected] = useState(false);
    const [appVersion, setAppVersion] = useState(null);
    const [liveLines, setLiveLines] = useState([]);
    const [actions, setActions] = useState([]);
    const [metricsHistory, setMetricsHistory] = useState([]);
    const [storedLogs, setStoredLogs] = useState([]);
    const [storedLogsReady, setStoredLogsReady] = useState(false);
    const [unreadLogCount, setUnreadLogCount] = useState(0);
    const [metricsRetentionMs, setMetricsRetentionMs] = useState(86_400_000);
    const [logsRetentionMs, setLogsRetentionMs] = useState(14 * 24 * 60 * 60 * 1000);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [appConfig, setAppConfig] = useState(null);
    const [deployOpen, setDeployOpen] = useState(false);
    const [deployments, setDeployments] = useState([]);
    const [activeDeploymentId, setActiveDeploymentId] = useState(null);
    const [deployProgressLines, setDeployProgressLines] = useState([]);
    const [deployProgressStage, setDeployProgressStage] = useState(null);
    const [deployProgressStatus, setDeployProgressStatus] = useState(null);
    /** @type {[object|null, React.Dispatch<object|null>]} deployment record being edited, or null */
    const [editingDeployment, setEditingDeployment] = useState(null);
    /** @type {[string|null, React.Dispatch<string|null>]} git status --porcelain output when a deploy is waiting for confirmation */
    const [deployConfirmChanges, setDeployConfirmChanges] = useState(null);
    const logRef = useRef(null);
    const autoStickRef = useRef(true);
    const prevLiveLinesLengthRef = useRef(0);
    const wsRef = useRef(null);

    const loadProcesses = useCallback(async () => {
        setProcessListStatus("Loading processes…");
        try {
            const payload = await fetchJson("/api/processes");
            setProcesses(payload.items);
            setProcessListStatus(`${payload.processCount} process(es)`);
            setSelectedProcessId((prev) =>
                payload.items.some((item) => String(item.id) === String(prev)) ? prev : payload.items[0]?.id ?? null
            );
        } catch (loadError) {
            setProcesses([]);
            setSelectedProcessId(null);
            setProcessListStatus(loadError.message);
            setError(loadError.message);
        }
    }, []);

    const loadDeployments = useCallback(() => {
        fetchJson('/api/deployments')
            .then((payload) => setDeployments(payload.deployments || []))
            .catch(() => {});
    }, []);

    useEffect(() => {
        fetchJson("/api/auth/session")
            .then((payload) => {
                setCsrfToken(payload.csrfToken);
                if (payload.version) setAppVersion(payload.version);
                if (payload.metricsRetentionMs) setMetricsRetentionMs(payload.metricsRetentionMs);
                if (payload.logsRetentionMs) setLogsRetentionMs(payload.logsRetentionMs);
                if (payload.config) setAppConfig(payload.config);
                return Promise.all([loadProcesses(), loadDeployments()]);
            })
            .catch((sessionError) => setError(sessionError.message));
    }, [loadProcesses, loadDeployments]);

    // Single unified WebSocket connection for all real-time data.
    useEffect(() => {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/stream`);
        wsRef.current = ws;

        ws.onopen = () => setWsConnected(true);
        ws.onclose = () => { setWsConnected(false); wsRef.current = null; };
        ws.onerror = () => setWsConnected(false);

        ws.onmessage = (event) => {
            try {
                const {type, data} = JSON.parse(event.data);
                if (type === "processes") {
                    setProcesses(data.items);
                    setProcessListStatus(`${data.processCount} process(es)`);
                    setSelectedProcessId((prev) =>
                        data.items.some((item) => String(item.id ?? item.name) === String(prev))
                            ? prev
                            : (data.items[0]?.id ?? data.items[0]?.name ?? null)
                    );
                } else if (type === "details") {
                    setDetails(data);
                } else if (type === "snapshot") {
                    setLiveLines(data.lines.map((l) => ({text: l.text})));
                } else if (type === "log") {
                    setLiveLines((prev) => [...prev, {text: data.text}].slice(-800));
                } else if (type === "error") {
                    setError(data.error);
                } else if (type === "deploy_progress") {
                    if (data.status === 'confirm') {
                        // Deployment is paused waiting for the user to approve discarding local changes.
                        setDeployConfirmChanges(data.line);
                    } else {
                        // Any other progress clears a stale confirmation prompt.
                        setDeployConfirmChanges(null);
                    }
                    setDeployProgressLines((prev) => [...prev, { stage: data.stage, line: data.line, status: data.status }]);
                    setDeployProgressStage(data.stage);
                    setDeployProgressStatus(data.status);
                    // Refresh deployments list when a deploy finishes or fails.
                    if (data.stage === 'done' || data.stage === 'error') {
                        loadDeployments();
                    }
                }
                // heartbeat and connected are intentionally ignored
            } catch {
                // Ignore malformed messages.
            }
        };

        return () => { ws.close(); wsRef.current = null; };
    }, []);

    // Derived: the full process object for the current selection (handles orphans with id=null).
    const selectedProcess = useMemo(
        () => processes.find((item) => String(item.id ?? item.name) === String(selectedProcessId)) || null,
        [processes, selectedProcessId]
    );

    const isSelectedMonitored = selectedProcess?.isMonitored ?? false;

    /** @type {object|null} Deployment record for the currently selected process, or null. */
    const selectedDeployment = useMemo(
        () => deployments.find((d) => d.pm2_name === selectedProcess?.name) ?? null,
        [deployments, selectedProcess]
    );

    /**
     * Deployments that exist in the DB but have no corresponding running PM2 process.
     * Each entry is annotated with a `displayStatus` field:
     *   - 'deploying' : a deploy is currently in progress
     *   - 'broken'    : first deploy failed, process never ran (last_deployed_at is null)
     *   - 'offline'   : was successfully deployed before, but is no longer in PM2
     *
     * @type {{ id: string, pm2_name: string, displayStatus: string }[]}
     */
    const offlineDeployments = useMemo(() => {
        const runningNames = new Set(processes.map((p) => p.name));
        return deployments
            .filter((d) => !runningNames.has(d.pm2_name))
            .map((d) => ({
                ...d,
                displayStatus: d.deploying
                    ? 'deploying'
                    : d.last_deployed_at == null
                        ? 'broken'
                        : 'offline',
            }));
    }, [deployments, processes]);

    // Fetch stored logs whenever the selected process changes, regardless of monitoring
    // state.  storedLogsReady gates the switch in allLines so combinedLines remain
    // visible until the fetch settles - preventing a blank flash on load.
    useEffect(() => {
        setStoredLogsReady(false);
        if (selectedProcessId === null || selectedProcessId === undefined) {
            setStoredLogs([]);
            setStoredLogsReady(true);
            return;
        }
        fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/logs/stored`)
            .then((payload) => {
                setStoredLogs(convertEntriesToLines(payload.entries || []));
                setStoredLogsReady(true);
            })
            .catch(() => {
                setStoredLogs([]);
                setStoredLogsReady(true);
            });
    }, [selectedProcessId]);

    // Reset local state and send select/deselect to the unified WS when the
    // selected process changes.  wsConnected is included so that on reconnect
    // the server is immediately told which process to stream.
    useEffect(() => {
        setDetails(null);
        setLiveLines([]);
        setActions([]);
        setMetricsHistory([]);
        setUnreadLogCount(0);
        prevLiveLinesLengthRef.current = 0;
        autoStickRef.current = true;

        const ws = wsRef.current;
        const isOpen = ws?.readyState === WebSocket.OPEN;

        if (selectedProcessId === null || selectedProcessId === undefined) {
            if (isOpen) ws.send(JSON.stringify({type: "deselect"}));
            return;
        }

        // Only send if the connection is fully open. When it is still
        // connecting, wsConnected will flip to true once onopen fires,
        // which re-runs this effect and sends the message then.
        if (isOpen) ws.send(JSON.stringify({type: "select", data: {processId: String(selectedProcessId)}}));

        fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/metrics`)
            .then((payload) => setMetricsHistory(payload.samples || []))
            .catch(() => setMetricsHistory([]));

        fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/actions`)
            .then((payload) => setActions(payload.actions || []))
            .catch(() => setActions([]));
    }, [selectedProcessId, wsConnected]);

    // Poll metrics every 20 s (matching the scheduler interval) so sparklines
    // update in real time without requiring a page refresh.
    useEffect(() => {
        if (selectedProcessId === null || selectedProcessId === undefined || !isSelectedMonitored) return;
        const interval = setInterval(() => {
            fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/metrics`)
                .then((payload) => setMetricsHistory(payload.samples || []))
                .catch(() => {});
        }, 20_000);
        return () => clearInterval(interval);
    }, [selectedProcessId, isSelectedMonitored]);

    useEffect(() => {
        const container = logRef.current;
        if (!container) return;
        const onScroll = () => {
            autoStickRef.current = container.scrollHeight - (container.scrollTop + container.clientHeight) < 48;
        };
        container.addEventListener("scroll", onScroll);
        return () => container.removeEventListener("scroll", onScroll);
    }, []);

    // Auto-scroll only when storedLogs changes (process switch / initial load).
    // details updates every 3 s and must not be in deps, otherwise the viewer
    // jumps to the bottom continuously while a process is selected.
    useEffect(() => {
        const container = logRef.current;
        if (container && autoStickRef.current) {
            container.scrollTop = container.scrollHeight;
        }
    }, [storedLogs]);

    // Track new live lines arriving while the user has scrolled up.
    // Accumulate a count so the indicator can show how many are pending.
    useEffect(() => {
        const added = liveLines.length - prevLiveLinesLengthRef.current;
        prevLiveLinesLengthRef.current = liveLines.length;
        if (added > 0 && !autoStickRef.current) {
            setUnreadLogCount((prev) => prev + added);
        }
    }, [liveLines]);

    const scrollToLogBottom = useCallback(() => {
        const container = logRef.current;
        if (container) {
            container.scrollTop = container.scrollHeight;
            autoStickRef.current = true;
            setUnreadLogCount(0);
        }
    }, []);

    /**
     * Build the line list for the log viewer.
     * - Monitored + stored logs ready: DB history (storedLogs) + new live lines.
     * - Unmonitored: liveLines only. The WS delivers an initial snapshot of the
     *   current log file contents followed by real-time bus events, so liveLines
     *   contains everything needed for display.
     *
     * The storedLogsReady gate ensures stored logs remain visible while the
     * async stored-log fetch is in flight, preventing a blank flash on load or
     * process switch.
     */
    const allLines = useMemo(() => {
        if (isSelectedMonitored && storedLogsReady) {
            return [...storedLogs, ...liveLines];
        }
        return liveLines;
    }, [isSelectedMonitored, storedLogsReady, storedLogs, liveLines]);

    const refreshCsrf = useCallback(async () => {
        const session = await fetchJson("/api/auth/session");
        setCsrfToken(session.csrfToken);
        return session.csrfToken;
    }, []);

    /**
     * Called by DeployModal when the server has accepted a deployment request.
     * Switches the modal to the progress view for the given deployment ID.
     *
     * @param {string} deploymentId
     */
    const onDeployStarted = useCallback((deploymentId) => {
        setDeployProgressLines([]);
        setDeployProgressStage('clone');
        setDeployProgressStatus('running');
        setActiveDeploymentId(deploymentId);
        // The deploy POST consumed the CSRF token — refresh it so subsequent
        // mutations (restart, stop, etc.) continue to work.
        refreshCsrf();
    }, [refreshCsrf]);

    /**
     * Called by DeployModal when the user clicks "Redeploy" while in edit mode.
     * The modal has already saved the updated config (PUT); this function refreshes
     * the CSRF token, switches the modal to the progress view, and fires the
     * redeploy POST request.
     *
     * @param {string} deploymentId - UUID of the deployment record.
     */
    const onSaveAndRedeploy = useCallback(async (deploymentId) => {
        // PUT already consumed the CSRF token -- get a fresh one before the POST.
        const newToken = await refreshCsrf();
        setEditingDeployment(null);
        setDeployProgressLines([]);
        setDeployProgressStage('clone');
        setDeployProgressStatus('running');
        setActiveDeploymentId(deploymentId);
        try {
            await fetchJson(`/api/deployments/${deploymentId}/redeploy`, {
                method: 'POST',
                headers: { 'X-CSRF-Token': newToken },
            });
            await refreshCsrf();
        } catch (err) {
            setDeployProgressLines((prev) => [...prev, { stage: 'error', line: err.message, status: 'error' }]);
            setDeployProgressStage('error');
            setDeployProgressStatus('error');
        }
    }, [refreshCsrf]);

    /**
     * Resolve a pending deployment confirmation from the deploy progress view.
     * Sends the user's decision (discard changes or cancel) to the server.
     *
     * @param {boolean} confirmed - True to discard local changes and continue; false to cancel.
     */
    const onConfirmDeploy = useCallback(async (confirmed) => {
        if (!activeDeploymentId) return;
        setDeployConfirmChanges(null);
        try {
            const freshToken = await refreshCsrf();
            await fetchJson(`/api/deployments/${activeDeploymentId}/confirm`, {
                method: 'POST',
                headers: { 'X-CSRF-Token': freshToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmed }),
            });
            await refreshCsrf();
        } catch (err) {
            setDeployProgressLines((prev) => [...prev, { stage: 'error', line: err.message, status: 'error' }]);
            setDeployProgressStage('error');
            setDeployProgressStatus('error');
        }
    }, [activeDeploymentId, refreshCsrf]);

    /**
     * Open the deploy modal in edit mode for the given PM2 process name.
     *
     * @param {string} pm2Name
     */
    const onEditDeployment = useCallback((pm2Name) => {
        const dep = deployments.find((d) => d.pm2_name === pm2Name);
        if (!dep) return;
        setEditingDeployment(dep);
        setDeployOpen(true);
    }, [deployments]);

    /**
     * Delete a deployment record from the DB without touching PM2.
     * Used for offline deployments (broken or missing from PM2).
     *
     * @param {string} deploymentId - UUID of the deployment record.
     */
    const onDeleteDeployment = useCallback(async (deploymentId) => {
        if (!csrfToken) return;
        try {
            await fetchJson(`/api/deployments/${deploymentId}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': csrfToken },
            });
            await refreshCsrf();
            loadDeployments();
        } catch (err) {
            setError(err.message);
        }
    }, [csrfToken, refreshCsrf, loadDeployments]);

    /**
     * Called after a deployment record has been successfully edited.
     * Refreshes the CSRF token, reloads the deployments list, and closes the modal.
     */
    const onEditSaved = useCallback(async () => {
        await refreshCsrf();
        loadDeployments();
        setDeployOpen(false);
        setEditingDeployment(null);
    }, [refreshCsrf, loadDeployments]);

    const onRestart = async () => {
        if (selectedProcessId === null || selectedProcessId === undefined || !csrfToken) {
            return;
        }
        try {
            await fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/restart`, {
                method: "POST",
                headers: {"X-CSRF-Token": csrfToken},
            });
            await refreshCsrf();
        } catch (restartError) {
            setError(restartError.message);
        }
    };

    /**
     * Delete the selected process from PM2.
     * When `withDeploy` is true the deployment record and its on-disk directory
     * are also removed.
     * Clears the selection afterwards so the UI does not point to a gone process.
     *
     * @param {boolean} withDeploy
     */
    const onDelete = async (withDeploy = false) => {
        if (selectedProcessId === null || selectedProcessId === undefined || !csrfToken) {
            return;
        }
        try {
            const url = `/api/processes/${encodeURIComponent(selectedProcessId)}${withDeploy ? '?deleteDeploy=true' : ''}`;
            await fetchJson(url, {
                method: "DELETE",
                headers: {"X-CSRF-Token": csrfToken},
            });
            await refreshCsrf();
            if (withDeploy) loadDeployments();
            setSelectedProcessId(null);
        } catch (deleteError) {
            setError(deleteError.message);
        }
    };

    /**
     * Remove an orphaned monitoring record from hawkeye.
     * Orphans are processes that are tracked in hawkeye's DB but no longer exist in PM2.
     *
     * @param {string} pm2Name - The PM2 process name of the orphaned record.
     */
    const onRemoveOrphan = async (pm2Name) => {
        if (!csrfToken) return;
        try {
            await fetchJson('/api/monitoring', {
                method: 'POST',
                headers: {'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json'},
                body: JSON.stringify({pm2Name, monitored: false}),
            });
            await refreshCsrf();
            // If the orphan was selected, clear the selection.
            setSelectedProcessId((prev) => (String(prev) === pm2Name ? null : prev));
        } catch {
            // Ignore - the WS stream will reflect the updated state shortly.
        }
    };

    const onLogout = async () => {
        if (csrfToken) {
            await fetchJson("/api/auth/logout", {
                method: "POST",
                headers: {"X-CSRF-Token": csrfToken}
            }).catch(() => undefined);
        }
        window.location.replace("/login");
    };

    /**
     * Toggle monitoring for a process.
     *
     * @param {string} pm2Name - The PM2 process name.
     * @param {boolean} currentlyMonitored - Current monitoring state.
     */
    const onToggleMonitoring = useCallback(async (pm2Name, currentlyMonitored) => {
        if (!csrfToken) return;
        try {
            await fetchJson(`/api/monitoring`, {
                method: "POST",
                headers: {"X-CSRF-Token": csrfToken, "Content-Type": "application/json"},
                body: JSON.stringify({pm2Name, monitored: !currentlyMonitored}),
            });
            await refreshCsrf();

            // Optimistically flip isMonitored in the local process list so the UI
            // updates immediately without waiting for the next WebSocket tick.
            const newMonitored = !currentlyMonitored;
            setProcesses((prev) =>
                prev.map((p) => (p.name === pm2Name ? { ...p, isMonitored: newMonitored } : p))
            );

            // After enabling monitoring, refresh stored data once the server has
            // had time to complete the log backfill (async on the server side).
            if (newMonitored) {
                // Close the gate immediately so allLines keeps showing liveLines
                // (the current snapshot) while the fetch is in flight, preventing
                // a blank flash during the 1500 ms backfill window.
                setStoredLogsReady(false);
                setTimeout(() => {
                    fetchJson(`/api/processes/${encodeURIComponent(pm2Name)}/metrics`)
                        .then((payload) => setMetricsHistory(payload.samples || []))
                        .catch(() => {});
                    fetchJson(`/api/processes/${encodeURIComponent(pm2Name)}/logs/stored`)
                        .then((payload) => {
                            // Batch all three updates so React renders them together:
                            // storedLogs carries the backfilled history, liveLines is
                            // cleared to avoid duplicating those same lines, and
                            // storedLogsReady opens the gate so allLines = storedLogs + [].
                            setStoredLogs(convertEntriesToLines(payload.entries || []));
                            setLiveLines([]);
                            setStoredLogsReady(true);
                        })
                        .catch(() => {
                            setStoredLogsReady(true);
                        });
                }, 1500);
            } else {
                setMetricsHistory([]);
                setStoredLogs([]);
                setStoredLogsReady(true); // keep gate open so combinedLines show immediately
            }
        } catch {
            // Ignore toggle errors; the WS stream will reflect the new state shortly.
        }
    }, [csrfToken, refreshCsrf]);

    /**
     * Toggle alert notifications for a monitored process.
     * Applies an optimistic local update, rolls back on failure.
     *
     * @param {string} pm2Name - The PM2 process name.
     * @param {boolean} currentlyEnabled - Current alerts_enabled state.
     */
    const onToggleAlert = useCallback(async (pm2Name, currentlyEnabled) => {
        if (!csrfToken) return;
        setProcesses((prev) =>
            prev.map((p) => (p.name === pm2Name ? {...p, alertsEnabled: !currentlyEnabled} : p))
        );
        try {
            await fetchJson('/api/notification-prefs', {
                method: 'POST',
                headers: {'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json'},
                body: JSON.stringify({pm2Name, alertsEnabled: !currentlyEnabled}),
            });
            await refreshCsrf();
        } catch {
            // Roll back optimistic update.
            setProcesses((prev) =>
                prev.map((p) => (p.name === pm2Name ? {...p, alertsEnabled: currentlyEnabled} : p))
            );
        }
    }, [csrfToken, refreshCsrf]);

    return (
        <div className="app-shell">
            <UpdateBanner />
            <ProcessList
                processes={processes}
                selectedProcessId={selectedProcessId}
                status={processListStatus}
                onSelect={setSelectedProcessId}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenDeploy={() => { setActiveDeploymentId(null); setDeployOpen(true); }}
                onToggleAlert={onToggleAlert}
                deployments={deployments}
                onEditDeployment={onEditDeployment}
                onRemoveOrphan={onRemoveOrphan}
                offlineDeployments={offlineDeployments}
                onDeleteDeployment={onDeleteDeployment}
            />
            <main className="content">
                <HeroCard
                    selectedProcess={selectedProcess}
                    details={details}
                    sseConnected={wsConnected}
                    onLogout={onLogout}
                    onRestart={onRestart}
                    onDelete={onDelete}
                    onRemoveOrphan={onRemoveOrphan}
                    selectedDeployment={selectedDeployment}
                    actions={actions}
                    selectedProcessId={selectedProcessId}
                    csrfToken={csrfToken}
                    onCsrfRefresh={refreshCsrf}
                />
                {selectedProcessId != null ? (
                    <>
                        <MonitoringNotice
                            isMonitored={isSelectedMonitored}
                            pm2Name={selectedProcess?.name ?? String(selectedProcessId)}
                            onToggleMonitoring={onToggleMonitoring}
                            metricsRetentionMs={metricsRetentionMs}
                            logsRetentionMs={logsRetentionMs}
                        />
                        <StatsGrid details={details} error={error} metricsHistory={metricsHistory} isMonitored={isSelectedMonitored} />
                        <LogStream
                            details={details}
                            allLines={allLines}
                            logRef={logRef}
                            isMonitored={isSelectedMonitored}
                            unreadCount={unreadLogCount}
                            onScrollToBottom={scrollToLogBottom}
                        />
                    </>
                ) : (
                    <div className="welcome-state">
                        <div className="welcome-card">
                            <p className="eyebrow">Getting started</p>
                            <h2>No process selected</h2>
                            <p className="subtle">
                                Select a PM2 process from the sidebar to view runtime metrics and logs.
                            </p>
                            <div className="welcome-hints">
                                <p className="welcome-hints-title">Enable monitoring on a process to unlock:</p>
                                <ul className="welcome-hints-list">
                                    <li>CPU and memory history sampled every 20 s, stored for 24 hours</li>
                                    <li>Log entries stored and searchable for 14 days</li>
                                    <li>Sparkline trend charts in the metrics panel</li>
                                </ul>
                                <p className="welcome-hints-note">
                                    Without monitoring, you only see live data - nothing is persisted between page loads.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </main>
            <Footer version={appVersion} />
            {settingsOpen && (
                <Settings
                    onClose={() => setSettingsOpen(false)}
                    csrfToken={csrfToken}
                    onCsrfRefresh={refreshCsrf}
                    appConfig={appConfig}
                />
            )}
            {deployOpen && (
                <DeployModal
                    csrfToken={csrfToken}
                    onCsrfRefresh={refreshCsrf}
                    onClose={() => { setDeployOpen(false); setActiveDeploymentId(null); setEditingDeployment(null); setDeployConfirmChanges(null); }}
                    onDeployStarted={onDeployStarted}
                    deployProgressLines={deployProgressLines}
                    deployProgressStage={deployProgressStage}
                    deployProgressStatus={deployProgressStatus}
                    activeDeploymentId={activeDeploymentId}
                    editingDeployment={editingDeployment}
                    onEditSaved={onEditSaved}
                    onSaveAndRedeploy={onSaveAndRedeploy}
                    confirmChanges={deployConfirmChanges}
                    onConfirmDeploy={onConfirmDeploy}
                />
            )}
        </div>
    );
}
