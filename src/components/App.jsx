/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, fetchWithCsrf } from '../services/api.js';
import { appendBounded, buildStoredLogsUrl, convertEntriesToLines, prependStoredLogPage } from '../services/logs.js';
import { createReconnectingWebSocket } from '../services/realtime.js';
import ProcessList from './ProcessList.jsx';
import ProcessHeader from './ProcessHeader.jsx';
import MetricsPanel from './MetricsPanel.jsx';
import ManagePanel from './ManagePanel.jsx';
import LogStream from './LogStream.jsx';
import UpdateBanner from './UpdateBanner.jsx';
import Footer from './Footer.jsx';
import Settings from './Settings.jsx';
import DeployModal from './DeployModal.jsx';
import HostMetrics from './HostMetrics.jsx';
import {
  IconContext,
  ICON_DEFAULTS,
  ChartLine,
  Eye,
  GearSix,
  List,
  RocketLaunch,
  SignOut,
  TextAlignLeft,
} from './Icon.jsx';

/** The three process-scoped views. Every per-process function lives in one. */
const TABS = [
  { id: 'logs', label: 'Logs' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'manage', label: 'Manage' },
];

export default function App() {
  const [csrfToken, setCsrfToken] = useState(null);
  const [processes, setProcesses] = useState([]);
  const [selectedProcessId, setSelectedProcessId] = useState(null);
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [liveLines, setLiveLines] = useState([]);
  const [actions, setActions] = useState([]);
  const [metricsHistory, setMetricsHistory] = useState([]);
  const [hostMetrics, setHostMetrics] = useState([]);
  const [hostCurrent, setHostCurrent] = useState(null);
  const [storedLogs, setStoredLogs] = useState([]);
  const [storedLogsReady, setStoredLogsReady] = useState(false);
  const [storedLogsCursor, setStoredLogsCursor] = useState(null);
  const [loadingOlderLogs, setLoadingOlderLogs] = useState(false);
  const [unreadLogCount, setUnreadLogCount] = useState(0);
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** @type {[Set<string>, React.Dispatch<Set<string>>]} active log level filters */
  const [logFilters, setLogFilters] = useState(new Set(['info', 'warn', 'error']));
  const [logSearch, setLogSearch] = useState('');
  const [logPaused, setLogPaused] = useState(false);
  /** How many lines are waiting behind the pause, shown in the toolbar. */
  const [pausedCount, setPausedCount] = useState(0);
  /**
   * Last known log level of the selected process, plus whether it answered.
   *
   * `supported` is null until the process has been asked, false when it did
   * not answer within the service's timeout.
   *
   * @type {[{supported: boolean|null, level: string|null, busy: boolean}, React.Dispatch<object>]}
   */
  const [logLevel, setLogLevel] = useState({ supported: null, level: null, busy: false });
  /** @type {['logs'|'metrics'|'manage', React.Dispatch<string>]} the active process tab */
  const [activeTab, setActiveTab] = useState('logs');
  const logRef = useRef(null);
  const autoStickRef = useRef(true);
  const prevLiveLinesLengthRef = useRef(0);
  const wsRef = useRef(null);
  const selectedProcessIdRef = useRef(null);
  const liveQueueRef = useRef([]);
  const liveFrameRef = useRef(null);
  const liveSequenceRef = useRef(0);
  const olderLogsControllerRef = useRef(null);
  // Pause has to be readable from inside the WebSocket handler, which closes
  // over its first render. A ref keeps the current value available there.
  const logPausedRef = useRef(false);
  /** Lines that arrived while the stream was paused, flushed on resume. */
  const pausedBufferRef = useRef([]);
  /** Mirrors activeDeploymentId for the WebSocket handler, which closes over its first render. */
  const activeDeploymentIdRef = useRef(null);

  const loadProcesses = useCallback(async () => {
    try {
      const payload = await fetchJson('/api/processes');
      setProcesses(payload.items);
      setSelectedProcessId((prev) =>
        payload.items.some((item) => String(item.id) === String(prev)) ? prev : (payload.items[0]?.id ?? null),
      );
    } catch (loadError) {
      setProcesses([]);
      setSelectedProcessId(null);
      setError(loadError.message);
    }
  }, []);

  const loadDeployments = useCallback(() => {
    fetchJson('/api/deployments')
      .then((payload) => setDeployments(payload.deployments || []))
      .catch((loadError) => setError(`Failed to load deployments: ${loadError.message}`));
  }, []);

  const loadHostMetrics = useCallback(() => {
    fetchJson('/api/host-metrics')
      .then((payload) => {
        setHostMetrics(payload.samples || []);
        setHostCurrent(payload.current || null);
      })
      .catch((loadError) => setError(`Failed to load host metrics: ${loadError.message}`));
  }, []);

  useEffect(() => {
    fetchJson('/api/auth/session')
      .then((payload) => {
        setCsrfToken(payload.csrfToken);
        if (payload.version) setAppVersion(payload.version);
        if (payload.config) setAppConfig(payload.config);
        return Promise.all([loadProcesses(), loadDeployments(), loadHostMetrics()]);
      })
      .catch((sessionError) => setError(sessionError.message));
  }, [loadProcesses, loadDeployments, loadHostMetrics]);

  // Poll host metrics every 20 s to keep sparklines current without a page refresh.
  useEffect(() => {
    const interval = setInterval(loadHostMetrics, 20_000);
    return () => clearInterval(interval);
  }, [loadHostMetrics]);

  useEffect(() => {
    activeDeploymentIdRef.current = activeDeploymentId;
  }, [activeDeploymentId]);

  useEffect(() => {
    selectedProcessIdRef.current = selectedProcessId;
  }, [selectedProcessId]);

  // Poll deployments every 60 s so branch-watch state (last check, last error)
  // stays current even when no deployment is running.
  useEffect(() => {
    const interval = setInterval(loadDeployments, 60_000);
    return () => clearInterval(interval);
  }, [loadDeployments]);

  // Single unified WebSocket connection for all real-time data.
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const flushLiveQueue = () => {
      liveFrameRef.current = null;
      const queued = liveQueueRef.current;
      liveQueueRef.current = [];
      if (queued.length === 0) return;
      if (logPausedRef.current) {
        pausedBufferRef.current = [...pausedBufferRef.current, ...queued].slice(-800);
        setPausedCount(pausedBufferRef.current.length);
      } else {
        setLiveLines((prev) => [...prev, ...queued].slice(-800));
      }
    };
    const queueLiveLine = (line) => {
      liveQueueRef.current = appendBounded(liveQueueRef.current, [line], 800);
      if (liveFrameRef.current === null) {
        liveFrameRef.current = requestAnimationFrame(flushLiveQueue);
      }
    };

    const connection = createReconnectingWebSocket({
      url: `${protocol}//${window.location.host}/ws/stream`,
      onStateChange: setWsConnected,
      onSocket: (socket) => {
        wsRef.current = socket;
      },
      onMessage: (event) => {
        try {
          const { type, data } = JSON.parse(event.data);
          if (type === 'processes') {
            setProcesses(data.items);
            setSelectedProcessId((prev) =>
              data.items.some((item) => String(item.id ?? item.name) === String(prev))
                ? prev
                : (data.items[0]?.id ?? data.items[0]?.name ?? null),
            );
            if (data.hostCurrent !== undefined) setHostCurrent(data.hostCurrent);
          } else if (type === 'details') {
            setDetails(data);
          } else if (type === 'snapshot') {
            setLiveLines(data.lines.map((l, index) => ({ key: `snapshot-${index}`, text: l.text })));
          } else if (type === 'log') {
            liveSequenceRef.current += 1;
            queueLiveLine({ key: `live-${liveSequenceRef.current}`, text: data.text });
          } else if (type === 'error') {
            setError(data.error);
          } else if (type === 'deploy_progress') {
            // Deploys started by the branch watcher run in the background and are
            // broadcast to every client. Only the deployment the user is watching
            // right now may feed the modal; the rest just refresh the list.
            if (activeDeploymentIdRef.current !== data.deploymentId) {
              if (data.stage === 'done' || data.stage === 'error') loadDeployments();
              return;
            }
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
      },
    });

    return () => {
      connection.close();
      if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
      liveFrameRef.current = null;
      liveQueueRef.current = [];
    };
  }, []);

  // Derived: the full process object for the current selection (handles orphans with id=null).
  const selectedProcess = useMemo(
    () => processes.find((item) => String(item.id ?? item.name) === String(selectedProcessId)) || null,
    [processes, selectedProcessId],
  );

  const isSelectedMonitored = selectedProcess?.isMonitored ?? false;

  /** @type {object|null} Deployment record for the currently selected process, or null. */
  const selectedDeployment = useMemo(
    () => deployments.find((d) => d.pm2_name === selectedProcess?.name) ?? null,
    [deployments, selectedProcess],
  );

  /**
   * Names of PM2 processes that Hawkeye deployed, so the sidebar can mark them.
   * Nothing distinguished them from processes started by hand before.
   *
   * @type {Set<string>}
   */
  const deployedNames = useMemo(() => new Set(deployments.map((d) => d.pm2_name)), [deployments]);

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
        displayStatus: d.deploying ? 'deploying' : d.last_deployed_at == null ? 'broken' : 'offline',
      }));
  }, [deployments, processes]);

  // Fetch stored logs whenever the selected process changes, regardless of monitoring
  // state.  storedLogsReady gates the switch in allLines so combinedLines remain
  // visible until the fetch settles - preventing a blank flash on load.
  useEffect(() => {
    const controller = new AbortController();
    olderLogsControllerRef.current?.abort();
    olderLogsControllerRef.current = null;
    setLoadingOlderLogs(false);
    setStoredLogsReady(false);
    setStoredLogsCursor(null);
    if (selectedProcessId === null || selectedProcessId === undefined) {
      setStoredLogs([]);
      setStoredLogsReady(true);
      return () => controller.abort();
    }
    fetchJson(buildStoredLogsUrl(selectedProcessId), { signal: controller.signal })
      .then((payload) => {
        setStoredLogs(convertEntriesToLines(payload.entries || []));
        setStoredLogsCursor(payload.nextCursor || null);
        setStoredLogsReady(true);
      })
      .catch((loadError) => {
        if (loadError.name === 'AbortError') return;
        setStoredLogs([]);
        setStoredLogsReady(true);
        setError(`Failed to load stored logs: ${loadError.message}`);
      });
    return () => controller.abort();
  }, [selectedProcessId]);

  // Reset process-scoped state and cancel requests when the selection changes.
  useEffect(() => {
    const controller = new AbortController();
    setDetails(null);
    setLiveLines([]);
    setActions([]);
    setMetricsHistory([]);
    setUnreadLogCount(0);
    // Held lines belong to the process we are leaving, so they are dropped
    // rather than flushed into the next one's stream.
    pausedBufferRef.current = [];
    liveQueueRef.current = [];
    liveSequenceRef.current = 0;
    if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
    liveFrameRef.current = null;
    setPausedCount(0);
    prevLiveLinesLengthRef.current = 0;
    autoStickRef.current = true;
    setLogSearch('');
    setDrawerOpen(false);
    setActiveTab('logs');

    if (selectedProcessId === null || selectedProcessId === undefined) {
      return () => controller.abort();
    }

    const requestOptions = { signal: controller.signal };
    fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/metrics`, requestOptions)
      .then((payload) => setMetricsHistory(payload.samples || []))
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') setError(`Failed to load metrics: ${loadError.message}`);
      });

    fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/actions`, requestOptions)
      .then((payload) => setActions(payload.actions || []))
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') setError(`Failed to load actions: ${loadError.message}`);
      });

    setLogLevel({ supported: null, level: null, busy: false });
    fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/log-level`, requestOptions)
      .then((payload) => setLogLevel({ supported: payload.supported, level: payload.level, busy: false }))
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') {
          setLogLevel({ supported: false, level: null, busy: false });
          setError(`Failed to load the log level: ${loadError.message}`);
        }
      });
    return () => controller.abort();
  }, [selectedProcessId]);

  // Select again after reconnecting so the server resumes the current stream.
  useEffect(() => {
    const ws = wsRef.current;
    if (!wsConnected || ws?.readyState !== WebSocket.OPEN) return;
    const message =
      selectedProcessId === null || selectedProcessId === undefined
        ? { type: 'deselect' }
        : { type: 'select', data: { processId: String(selectedProcessId) } };
    ws.send(JSON.stringify(message));
  }, [selectedProcessId, wsConnected]);

  // Poll metrics every 20 s (matching the scheduler interval) so sparklines
  // update in real time without requiring a page refresh.
  useEffect(() => {
    if (selectedProcessId === null || selectedProcessId === undefined || !isSelectedMonitored) return;
    let controller = null;
    const interval = setInterval(() => {
      controller?.abort();
      controller = new AbortController();
      fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/metrics`, { signal: controller.signal })
        .then((payload) => setMetricsHistory(payload.samples || []))
        .catch((loadError) => {
          if (loadError.name !== 'AbortError') setError(`Failed to refresh metrics: ${loadError.message}`);
        });
    }, 20_000);
    return () => {
      clearInterval(interval);
      controller?.abort();
    };
  }, [selectedProcessId, isSelectedMonitored]);

  // Track whether the user is parked at the bottom of the log viewer. The
  // listener is re-attached when the Logs tab mounts, since the scroll
  // container only exists while that tab is rendered.
  useEffect(() => {
    const container = logRef.current;
    if (!container) return undefined;
    const onScroll = () => {
      autoStickRef.current = container.scrollHeight - (container.scrollTop + container.clientHeight) < 48;
    };
    container.addEventListener('scroll', onScroll);
    return () => container.removeEventListener('scroll', onScroll);
  }, [activeTab, selectedProcessId]);

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

  /**
   * Pause or resume the live log stream.
   *
   * Resuming flushes everything that arrived while paused, so pausing to read
   * something never loses lines.
   */
  const onTogglePause = useCallback(() => {
    setLogPaused((paused) => {
      const next = !paused;
      logPausedRef.current = next;
      if (!next && pausedBufferRef.current.length > 0) {
        const buffered = pausedBufferRef.current;
        pausedBufferRef.current = [];
        setPausedCount(0);
        setLiveLines((prev) => [...prev, ...buffered].slice(-800));
      }
      return next;
    });
  }, []);

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

  /** Load the next older stored-log page without replacing newer lines. */
  const loadOlderLogs = useCallback(async () => {
    const processId = selectedProcessIdRef.current;
    if (processId == null || !storedLogsCursor || loadingOlderLogs) return;
    const controller = new AbortController();
    olderLogsControllerRef.current?.abort();
    olderLogsControllerRef.current = controller;
    setLoadingOlderLogs(true);
    try {
      const payload = await fetchJson(buildStoredLogsUrl(processId, storedLogsCursor), { signal: controller.signal });
      if (String(selectedProcessIdRef.current) !== String(processId)) return;
      const older = convertEntriesToLines(payload.entries || []);
      setStoredLogs((current) => prependStoredLogPage(current, older));
      setStoredLogsCursor(payload.nextCursor || null);
    } catch (loadError) {
      if (loadError.name === 'AbortError') return;
      if (String(selectedProcessIdRef.current) === String(processId)) {
        setError(`Failed to load older logs: ${loadError.message}`);
      }
    } finally {
      if (olderLogsControllerRef.current === controller) {
        olderLogsControllerRef.current = null;
        setLoadingOlderLogs(false);
      }
    }
  }, [loadingOlderLogs, storedLogsCursor]);

  const refreshCsrf = useCallback(async () => {
    const session = await fetchJson('/api/auth/session');
    setCsrfToken(session.csrfToken);
    return session.csrfToken;
  }, []);

  /**
   * Open the Metrics tab and bring one chart into view.
   *
   * The readouts in the top bar and the process header are shortcuts into this
   * tab, not chart surfaces of their own: every chart is drawn once, in
   * MetricsPanel.
   *
   * @param {string} [chartId] - id of the target MetricCard, e.g. 'metric-cpu'.
   */
  const showMetric = useCallback((chartId) => {
    setActiveTab('metrics');
    if (!chartId) return;
    // The panel only mounts once the tab switches, so wait for it to be painted
    // before scrolling. Two frames: one for the render, one for the layout.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const target = document.getElementById(chartId);
        if (!target) return;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      }),
    );
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
  }, []);

  /**
   * Called by DeployModal when the user clicks "Redeploy" while in edit mode.
   * The modal has already saved the updated config (PUT); this function refreshes
   * the CSRF token, switches the modal to the progress view, and fires the
   * redeploy POST request.
   *
   * @param {string} deploymentId - UUID of the deployment record.
   */
  const onSaveAndRedeploy = useCallback(
    async (deploymentId) => {
      setEditingDeployment(null);
      setDeployProgressLines([]);
      setDeployProgressStage('clone');
      setDeployProgressStatus('running');
      setActiveDeploymentId(deploymentId);
      try {
        await fetchWithCsrf(`/api/deployments/${deploymentId}/redeploy`, {
          onCsrfRefresh: refreshCsrf,
          method: 'POST',
        });
      } catch (err) {
        setDeployProgressLines((prev) => [...prev, { stage: 'error', line: err.message, status: 'error' }]);
        setDeployProgressStage('error');
        setDeployProgressStatus('error');
      }
    },
    [refreshCsrf],
  );

  /**
   * Resolve a pending deployment confirmation from the deploy progress view.
   * Sends the user's decision (discard changes or cancel) to the server.
   *
   * @param {boolean} confirmed - True to discard local changes and continue; false to cancel.
   */
  const onConfirmDeploy = useCallback(
    async (confirmed) => {
      if (!activeDeploymentId) return;
      setDeployConfirmChanges(null);
      try {
        await fetchWithCsrf(`/api/deployments/${activeDeploymentId}/confirm`, {
          onCsrfRefresh: refreshCsrf,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed }),
        });
      } catch (err) {
        setDeployProgressLines((prev) => [...prev, { stage: 'error', line: err.message, status: 'error' }]);
        setDeployProgressStage('error');
        setDeployProgressStatus('error');
      }
    },
    [activeDeploymentId, refreshCsrf],
  );

  /**
   * Open the deploy modal in edit mode for the given PM2 process name.
   *
   * @param {string} pm2Name
   */
  const onEditDeployment = useCallback(
    (pm2Name) => {
      const dep = deployments.find((d) => d.pm2_name === pm2Name);
      if (!dep) return;
      setEditingDeployment(dep);
      setDeployOpen(true);
    },
    [deployments],
  );

  /**
   * Delete a deployment record from the DB without touching PM2.
   * Used for offline deployments (broken or missing from PM2).
   *
   * @param {string} deploymentId - UUID of the deployment record.
   */
  const onDeleteDeployment = useCallback(
    async (deploymentId) => {
      if (!csrfToken) return;
      try {
        await fetchWithCsrf(`/api/deployments/${deploymentId}`, {
          onCsrfRefresh: refreshCsrf,
          method: 'DELETE',
        });
        loadDeployments();
      } catch (err) {
        setError(err.message);
      }
    },
    [csrfToken, refreshCsrf, loadDeployments],
  );

  /**
   * Called after a deployment record has been successfully edited.
   * Reloads the deployments list and closes the modal.
   */
  const onEditSaved = useCallback(async () => {
    loadDeployments();
    setDeployOpen(false);
    setEditingDeployment(null);
  }, [loadDeployments]);

  const onRestart = async () => {
    if (selectedProcessId === null || selectedProcessId === undefined || !csrfToken) {
      return;
    }
    try {
      await fetchWithCsrf(`/api/processes/${encodeURIComponent(selectedProcessId)}/restart`, {
        onCsrfRefresh: refreshCsrf,
        method: 'POST',
      });
    } catch (restartError) {
      setError(restartError.message);
    }
  };

  /**
   * Stop the selected PM2 process without removing it from PM2.
   * The process stays in the list with a `stopped` status so it can be
   * started again via {@link onStart}.
   */
  const onStop = async () => {
    if (selectedProcessId === null || selectedProcessId === undefined || !csrfToken) {
      return;
    }
    try {
      await fetchWithCsrf(`/api/processes/${encodeURIComponent(selectedProcessId)}/stop`, {
        onCsrfRefresh: refreshCsrf,
        method: 'POST',
      });
    } catch (stopError) {
      setError(stopError.message);
    }
  };

  /**
   * Start the selected (stopped) PM2 process.
   */
  const onStart = async () => {
    if (selectedProcessId === null || selectedProcessId === undefined || !csrfToken) {
      return;
    }
    try {
      await fetchWithCsrf(`/api/processes/${encodeURIComponent(selectedProcessId)}/start`, {
        onCsrfRefresh: refreshCsrf,
        method: 'POST',
      });
    } catch (startError) {
      setError(startError.message);
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
      await fetchWithCsrf(url, {
        onCsrfRefresh: refreshCsrf,
        method: 'DELETE',
      });
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
      await fetchWithCsrf('/api/monitoring', {
        onCsrfRefresh: refreshCsrf,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pm2Name, monitored: false }),
      });
      // If the orphan was selected, clear the selection.
      setSelectedProcessId((prev) => (String(prev) === pm2Name ? null : prev));
    } catch (removeError) {
      setError(removeError.message);
    }
  };

  const onLogout = async () => {
    if (csrfToken) {
      await fetchWithCsrf('/api/auth/logout', {
        onCsrfRefresh: refreshCsrf,
        // A successful logout destroys the session, so the post-request token
        // refresh is expected to fail immediately before navigation.
        onCsrfRefreshError: () => {},
        method: 'POST',
      }).catch(() => undefined);
    }
    window.location.replace('/login');
  };

  /**
   * Toggle monitoring for a process.
   *
   * @param {string} pm2Name - The PM2 process name.
   * @param {boolean} currentlyMonitored - Current monitoring state.
   */
  const onToggleMonitoring = useCallback(
    async (pm2Name, currentlyMonitored) => {
      if (!csrfToken) return;
      try {
        await fetchWithCsrf(`/api/monitoring`, {
          onCsrfRefresh: refreshCsrf,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pm2Name, monitored: !currentlyMonitored }),
        });

        // Optimistically flip isMonitored in the local process list so the UI
        // updates immediately without waiting for the next WebSocket tick.
        const newMonitored = !currentlyMonitored;
        setProcesses((prev) => prev.map((p) => (p.name === pm2Name ? { ...p, isMonitored: newMonitored } : p)));
      } catch (toggleError) {
        setError(toggleError.message);
      }
    },
    [csrfToken, refreshCsrf],
  );

  /**
   * Toggle alert notifications for a monitored process.
   *
   * The backend has always exposed this route; the previous UI displayed the
   * resulting state as an icon but offered no way to change it.
   *
   * @param {string} pm2Name - The PM2 process name.
   * @param {boolean} alertsEnabled - Desired state.
   */
  const onToggleAlerts = useCallback(
    async (pm2Name, alertsEnabled) => {
      if (!csrfToken) return;
      // Optimistic update so the switch responds immediately.
      setProcesses((prev) => prev.map((p) => (p.name === pm2Name ? { ...p, alertsEnabled } : p)));
      try {
        await fetchWithCsrf('/api/notification-prefs', {
          onCsrfRefresh: refreshCsrf,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pm2Name, alertsEnabled }),
        });
      } catch (err) {
        // Roll back the optimistic flip and surface the failure.
        setProcesses((prev) => prev.map((p) => (p.name === pm2Name ? { ...p, alertsEnabled: !alertsEnabled } : p)));
        setError(err.message);
      }
    },
    [csrfToken, refreshCsrf],
  );

  /**
   * Set the log level of the running process.
   *
   * The level is not stored anywhere: it lives in the process until it
   * restarts, and the answer reports what the process actually ended up with,
   * which can differ from what was asked for.
   *
   * @param {string} level
   */
  const onSetLogLevel = useCallback(
    async (level) => {
      if (!csrfToken || selectedProcessId == null) return;
      const processId = selectedProcessId;
      setLogLevel((prev) => ({ ...prev, busy: true }));
      try {
        const payload = await fetchWithCsrf(`/api/processes/${encodeURIComponent(processId)}/log-level`, {
          onCsrfRefresh: refreshCsrf,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level }),
        });
        if (String(selectedProcessIdRef.current) !== String(processId)) return;
        setLogLevel({ supported: payload.supported, level: payload.level, busy: false });

        // A narrowed log filter would hide the very lines the user just asked
        // for, which reads as the feature being broken. The filter row has no
        // debug button, so widen it here rather than leaving a dead end.
        if (payload.supported && (level === 'debug' || level === 'trace')) {
          setLogFilters((prev) => (prev.size < 3 ? new Set([...prev, 'debug']) : prev));
        }
      } catch (err) {
        if (String(selectedProcessIdRef.current) !== String(processId)) return;
        setLogLevel((prev) => ({ ...prev, busy: false }));
        setError(err.message);
      }
    },
    [csrfToken, selectedProcessId, refreshCsrf],
  );

  const hasSelection = selectedProcessId != null;

  return (
    <IconContext.Provider value={ICON_DEFAULTS}>
      <div className="app-shell">
        <UpdateBanner />

        <header className="app-topbar">
          <button
            className="topbar-menu-btn"
            type="button"
            aria-label="Toggle process list"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((o) => !o)}
          >
            <List size={15} weight="bold" />
          </button>

          <a className="topbar-brand" href="/" aria-label="pm2-hawkeye home">
            <span className="topbar-brand-logo">
              <Eye size={15} weight="bold" color="var(--accent)" />
            </span>
            <span className="topbar-brand-wordmark">
              <span className="brand-pm2">pm2</span>
              <span className="brand-hawkeye">-hawkeye</span>
            </span>
          </a>

          <HostMetrics
            samples={hostMetrics}
            current={hostCurrent}
            onShowMetrics={hasSelection && selectedProcess ? showMetric : null}
          />
          <span className="topbar-spacer" />

          <div className="conn-state" data-connected={wsConnected} title={wsConnected ? 'Live' : 'Reconnecting'}>
            <span className="conn-dot" />
            <span>{wsConnected ? 'Live' : 'Reconnecting'}</span>
          </div>

          <span className="topbar-divider" />

          <div className="topbar-actions">
            <button
              className="btn btn--primary btn--sm"
              type="button"
              aria-label="Deploy from Git"
              onClick={() => {
                setActiveDeploymentId(null);
                setDeployOpen(true);
              }}
            >
              <RocketLaunch size={13} weight="bold" />
              {/* The label is hidden on narrow viewports; the aria-label carries it. */}
              <span>Deploy</span>
            </button>
            <button
              className="btn btn--icon"
              type="button"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <GearSix size={15} />
            </button>
            <button className="btn btn--icon" type="button" title="Sign out" aria-label="Sign out" onClick={onLogout}>
              <SignOut size={15} />
            </button>
          </div>
        </header>

        {drawerOpen && <div className="topbar-drawer-overlay" onClick={() => setDrawerOpen(false)} />}

        <ProcessList
          processes={processes}
          selectedProcessId={selectedProcessId}
          onSelect={(id) => {
            setSelectedProcessId(id);
            setDrawerOpen(false);
          }}
          onEditDeployment={onEditDeployment}
          deployedNames={deployedNames}
          offlineDeployments={offlineDeployments}
          onDeleteDeployment={onDeleteDeployment}
          drawerOpen={drawerOpen}
        />

        <main className="content">
          {error && (
            <div className="action-result" data-ok="false" style={{ margin: 'var(--s-3) var(--s-5) 0' }}>
              <span>{error}</span>
              <button type="button" className="btn btn--sm btn--quiet" onClick={() => setError('')}>
                Dismiss
              </button>
            </div>
          )}

          {hasSelection && selectedProcess ? (
            <>
              <ProcessHeader
                selectedProcess={selectedProcess}
                details={details}
                selectedDeployment={selectedDeployment}
                onRestart={onRestart}
                onStop={onStop}
                onStart={onStart}
                onEditDeployment={onEditDeployment}
                onShowMetrics={showMetric}
              >
                <div className="tabs" role="tablist" aria-label="Process views">
                  {TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      id={`tab-${tab.id}`}
                      aria-selected={activeTab === tab.id}
                      aria-controls={`panel-${tab.id}`}
                      className="tab"
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                      {tab.id === 'logs' && allLines.length > 0 && <span className="tab-count">{allLines.length}</span>}
                      {tab.id === 'manage' && !isSelectedMonitored && (
                        <span className="tab-flag" title="Monitoring is off for this process" />
                      )}
                    </button>
                  ))}
                </div>
              </ProcessHeader>

              <div
                className={activeTab === 'logs' ? 'tab-panel' : 'tab-panel tab-panel--scroll'}
                role="tabpanel"
                id={`panel-${activeTab}`}
                aria-labelledby={`tab-${activeTab}`}
              >
                {activeTab === 'logs' && (
                  <LogStream
                    details={details}
                    allLines={allLines}
                    logRef={logRef}
                    isMonitored={isSelectedMonitored}
                    unreadCount={unreadLogCount}
                    onScrollToBottom={scrollToLogBottom}
                    logFilters={logFilters}
                    onToggleFilter={(level) =>
                      setLogFilters((prev) => {
                        const next = new Set(prev);
                        if (next.has(level)) next.delete(level);
                        else next.add(level);
                        return next;
                      })
                    }
                    logSearch={logSearch}
                    onSearchChange={setLogSearch}
                    logPaused={logPaused}
                    pausedCount={pausedCount}
                    onTogglePause={onTogglePause}
                    hasOlderLogs={Boolean(storedLogsCursor)}
                    loadingOlderLogs={loadingOlderLogs}
                    onLoadOlderLogs={loadOlderLogs}
                  />
                )}

                {activeTab === 'metrics' && (
                  <MetricsPanel
                    details={details}
                    metricsHistory={metricsHistory}
                    hostSamples={hostMetrics}
                    hostCurrent={hostCurrent}
                    isMonitored={isSelectedMonitored}
                    onEnableMonitoring={() => onToggleMonitoring(selectedProcess.name, false)}
                  />
                )}

                {activeTab === 'manage' && (
                  <ManagePanel
                    selectedProcess={selectedProcess}
                    isMonitored={isSelectedMonitored}
                    onToggleMonitoring={onToggleMonitoring}
                    onToggleAlerts={onToggleAlerts}
                    actions={actions}
                    logLevel={logLevel}
                    onSetLogLevel={onSetLogLevel}
                    selectedProcessId={selectedProcessId}
                    csrfToken={csrfToken}
                    onCsrfRefresh={refreshCsrf}
                    selectedDeployment={selectedDeployment}
                    onEditDeployment={onEditDeployment}
                    onDelete={onDelete}
                    onRemoveOrphan={onRemoveOrphan}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="welcome-state">
              <div className="welcome-card">
                <h2>No process selected</h2>
                <p className="subtle">
                  Pick a PM2 process on the left to read its logs, chart its resource use, and manage it.
                </p>
                <div className="welcome-hints">
                  <p className="welcome-hints-title">Each process gets three views.</p>
                  <ul className="welcome-hints-list">
                    <li>
                      <span className="welcome-hint-icon">
                        <TextAlignLeft size={13} />
                      </span>
                      <span>
                        <strong>Logs</strong>
                        stdout and stderr merged, filterable by level and searchable.
                      </span>
                    </li>
                    <li>
                      <span className="welcome-hint-icon">
                        <ChartLine size={13} />
                      </span>
                      <span>
                        <strong>Metrics</strong>
                        CPU and memory over time, next to host CPU, RAM and disk.
                      </span>
                    </li>
                    <li>
                      <span className="welcome-hint-icon">
                        <GearSix size={13} />
                      </span>
                      <span>
                        <strong>Manage</strong>
                        Monitoring, alerts, PM2 custom actions, deployment and removal.
                      </span>
                    </li>
                  </ul>
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
            onClose={() => {
              setDeployOpen(false);
              setActiveDeploymentId(null);
              setEditingDeployment(null);
              setDeployConfirmChanges(null);
            }}
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
    </IconContext.Provider>
  );
}
