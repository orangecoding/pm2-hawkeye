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
    const logRef = useRef(null);
    const autoStickRef = useRef(true);
    const prevLiveLinesLengthRef = useRef(0);

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

    useEffect(() => {
        fetchJson("/api/auth/session")
            .then((payload) => {
                setCsrfToken(payload.csrfToken);
                if (payload.version) setAppVersion(payload.version);
            })
            .then(loadProcesses)
            .catch((sessionError) => setError(sessionError.message));
    }, [loadProcesses]);

    // WebSocket stream for process list updates every 3 seconds.
    useEffect(() => {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/processes/stream`);
        ws.onmessage = (event) => {
            try {
                const {type, data} = JSON.parse(event.data);
                if (type === "processes") {
                    setProcesses(data.items);
                    setProcessListStatus(`${data.processCount} process(es)`);
                    // Keep selection if the process still exists (match by id OR name for orphans).
                    setSelectedProcessId((prev) =>
                        data.items.some((item) => String(item.id ?? item.name) === String(prev))
                            ? prev
                            : (data.items[0]?.id ?? data.items[0]?.name ?? null)
                    );
                }
            } catch {
                // Ignore malformed messages.
            }
        };
        return () => ws.close();
    }, []);

    // Derived: the full process object for the current selection (handles orphans with id=null).
    const selectedProcess = useMemo(
        () => processes.find((item) => String(item.id ?? item.name) === String(selectedProcessId)) || null,
        [processes, selectedProcessId]
    );

    const isSelectedMonitored = selectedProcess?.isMonitored ?? false;

    // Fetch stored logs whenever the selected process changes, regardless of monitoring
    // state.  storedLogsReady gates the switch in allLines so combinedLines remain
    // visible until the fetch settles — preventing a blank flash on load.
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

    useEffect(() => {
        if (selectedProcessId === null || selectedProcessId === undefined) {
            setDetails(null);
            setLiveLines([]);
            setActions([]);
            setMetricsHistory([]);
            setUnreadLogCount(0);
            prevLiveLinesLengthRef.current = 0;
            autoStickRef.current = true;
            return;
        }
        autoStickRef.current = true;
        setUnreadLogCount(0);
        // Fetch stored metrics history when a process is selected.
        setMetricsHistory([]);
        fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/metrics`)
            .then((payload) => setMetricsHistory(payload.samples || []))
            .catch(() => setMetricsHistory([]));

        fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/actions`)
            .then((payload) => setActions(payload.actions || []))
            .catch(() => setActions([]));
        setLiveLines([]);
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/processes/${encodeURIComponent(selectedProcessId)}/details`);
        ws.onmessage = (event) => {
            try {
                const {type, data} = JSON.parse(event.data);
                if (type === "details") {
                    setDetails(data);
                } else if (type === "error") {
                    setError(data.error);
                }
            } catch {
                // Ignore malformed messages.
            }
        };
        ws.onerror = () => setError("WebSocket error loading process details");
        return () => ws.close();
    }, [selectedProcessId]);

    useEffect(() => {
        if (selectedProcessId === null || selectedProcessId === undefined) return undefined;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/processes/${encodeURIComponent(selectedProcessId)}/logs`);
        ws.onopen = () => setWsConnected(true);
        ws.onmessage = (event) => {
            try {
                const {type, data} = JSON.parse(event.data);
                if (type === 'snapshot') {
                    setLiveLines(data.lines.map((l) => ({text: l.text})));
                } else if (type === 'log') {
                    setLiveLines((prev) => [...prev, {text: data.text}].slice(-800));
                } else if (type === 'error') {
                    setError(data.error);
                }
            } catch {
                // Ignore malformed messages.
            }
        };
        ws.onclose = () => setWsConnected(false);
        ws.onerror = () => setWsConnected(false);
        return () => {
            ws.close();
            setWsConnected(false);
        };
    }, [selectedProcessId]);

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

    useEffect(() => {
        const container = logRef.current;
        if (container && autoStickRef.current) {
            container.scrollTop = container.scrollHeight;
        }
    }, [details, liveLines, storedLogs]);

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
    }, []);

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
            await fetchJson(`/api/processes/${encodeURIComponent(pm2Name)}/monitoring`, {
                method: "POST",
                headers: {"X-CSRF-Token": csrfToken, "Content-Type": "application/json"},
                body: JSON.stringify({monitored: !currentlyMonitored}),
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

    return (
        <div className="app-shell">
            <UpdateBanner />
            <ProcessList
                processes={processes}
                selectedProcessId={selectedProcessId}
                status={processListStatus}
                onSelect={setSelectedProcessId}
                onRefresh={loadProcesses}
            />
            <main className="content">
                <HeroCard
                    selectedProcess={selectedProcess}
                    details={details}
                    sseConnected={wsConnected}
                    onLogout={onLogout}
                    onRestart={onRestart}
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
                                    Without monitoring, you only see live data — nothing is persisted between page loads.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </main>
            <Footer version={appVersion} />
        </div>
    );
}
