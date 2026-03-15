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
import UpdateBanner from "./UpdateBanner.jsx";

export default function App() {
    const [csrfToken, setCsrfToken] = useState(null);
    const [processes, setProcesses] = useState([]);
    const [selectedProcessId, setSelectedProcessId] = useState(null);
    const [details, setDetails] = useState(null);
    const [processListStatus, setProcessListStatus] = useState("Loading processes…");
    const [error, setError] = useState("");
    const [wsConnected, setWsConnected] = useState(false);
    const [liveLines, setLiveLines] = useState([]);
    const [actions, setActions] = useState([]);
    const logRef = useRef(null);
    const autoStickRef = useRef(true);

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
            })
            .then(loadProcesses)
            .catch((sessionError) => setError(sessionError.message));
    }, [loadProcesses]);

    // WebSocket stream for process list updates every 3 seconds
    useEffect(() => {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/processes/stream`);
        ws.onmessage = (event) => {
            try {
                const { type, data } = JSON.parse(event.data);
                if (type === "processes") {
                    setProcesses(data.items);
                    setProcessListStatus(`${data.processCount} process(es)`);
                    setSelectedProcessId((prev) =>
                        data.items.some((item) => String(item.id) === String(prev)) ? prev : data.items[0]?.id ?? null
                    );
                }
            } catch {
                // Ignore malformed messages.
            }
        };
        return () => ws.close();
    }, []);

    useEffect(() => {
        if (selectedProcessId === null || selectedProcessId === undefined) {
            setDetails(null);
            setLiveLines([]);
            setActions([]);
            return;
        }
        fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/actions`)
            .then((payload) => setActions(payload.actions || []))
            .catch(() => setActions([]));
        setLiveLines([]);
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/processes/${encodeURIComponent(selectedProcessId)}/details`);
        ws.onmessage = (event) => {
            try {
                const { type, data } = JSON.parse(event.data);
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
                const { type, data } = JSON.parse(event.data);
                if (type === "log") {
                    setLiveLines((prev) => [...prev, {text: data.text, source: "live"}].slice(-800));
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
    }, [details, liveLines]);

    const allLines = useMemo(() => [
        ...(details?.logs?.combinedLines || []).map((line) => ({text: line.text, source: line.source})),
        ...liveLines,
    ], [details, liveLines]);

    const selectedProcess = useMemo(
        () => processes.find((item) => String(item.id) === String(selectedProcessId)) || null,
        [processes, selectedProcessId]
    );

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
                <StatsGrid details={details} error={error}/>
                <LogStream
                    details={details}
                    allLines={allLines}
                    logRef={logRef}
                />
            </main>
        </div>
    );
}
