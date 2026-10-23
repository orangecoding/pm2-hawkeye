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
import DeployPanel from './DeployPanel.jsx';
import HostMetrics from './HostMetrics.jsx';
import Overview from './Overview.jsx';
import { buildAttentionItems } from '../services/attention.js';
import {
  deployTabDot,
  deploymentIdFromKey,
  deploymentKey,
  isRunActive,
  recordDeployEvent,
  startRun,
} from '../services/deployment.js';
import { IconContext, ICON_DEFAULTS, Eye, GearSix, List, Plus, SignOut } from './Icon.jsx';

/**
 * Key that identifies a process row: its pm_id, or its name for an orphan,
 * which has no pm_id.
 *
 * @param {{ id: number|null, name: string }} item
 * @returns {number|string}
 */
function processKey(item) {
  return item.id ?? item.name;
}

/**
 * Keep the current process selection while the process is still in the list,
 * otherwise fall back to the Overview (null).
 *
 * Deployment keys are left alone here: they are checked against the
 * deployment list instead, see the effect that follows `selection`.
 *
 * @param {object[]} items - Process list rows.
 * @param {number|string|null} prev - Current selection.
 * @returns {number|string|null}
 */
function keepSelection(items, prev) {
  if (prev == null || deploymentIdFromKey(prev)) return prev;
  return items.some((item) => String(processKey(item)) === String(prev)) ? prev : null;
}

/**
 * Bring an element into view once the screen that holds it has rendered.
 * Two frames: one for the render, one for the layout.
 *
 * @param {string} elementId
 */
function scrollToWhenRendered(elementId) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const target = document.getElementById(elementId);
      if (!target) return;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    }),
  );
}

/**
 * The process-scoped views. Every per-process function lives in exactly one.
 * Deploy only exists for processes Hawkeye deployed.
 */
const TABS = [
  { id: 'logs', label: 'Logs' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'manage', label: 'Manage' },
];

/**
 * Application shell: owns all state and API calls, and routes between the
 * Overview (nothing selected), a process with its tabs, and a deployment that
 * has no PM2 process.
 */
export default function App() {
  const [csrfToken, setCsrfToken] = useState(null);
  const [processes, setProcesses] = useState([]);
  /**
   * What the content area shows: null for the Overview, a pm_id (or the name
   * of an orphan) for a process, or `deployment:<id>` for a deployment without
   * a PM2 process.
   *
   * @type {[number|string|null, React.Dispatch<number|string|null>]}
   */
  const [selection, setSelection] = useState(null);
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [liveLines, setLiveLines] = useState([]);
  const [actions, setActions] = useState([]);
  const [metricsHistory, setMetricsHistory] = useState([]);
  const [customMetricsHistory, setCustomMetricsHistory] = useState([]);
  const [hostMetrics, setHostMetrics] = useState([]);
  const [hostCurrent, setHostCurrent] = useState(null);
  const [storedLogs, setStoredLogs] = useState([]);
  const [storedLogsReady, setStoredLogsReady] = useState(false);
  const [storedLogsCursor, setStoredLogsCursor] = useState(null);
  const [loadingOlderLogs, setLoadingOlderLogs] = useState(false);
  const [unreadLogCount, setUnreadLogCount] = useState(0);
  /** @type {[null|'General'|'Alerting', React.Dispatch<null|'General'|'Alerting'>]} open Settings page, or null */
  const [settingsPage, setSettingsPage] = useState(null);
  const [appConfig, setAppConfig] = useState(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployments, setDeployments] = useState([]);
  const [deploymentsLoaded, setDeploymentsLoaded] = useState(false);
  /**
   * Deployment runs seen in this browser session, keyed by deployment id:
   * `{ lines, stage, status, confirmChanges, firstDeploy, startedAt,
   * finishedAt, dismissed }`. Bounded, see RUN_LIMITS in services/deployment.js.
   *
   * @type {[Record<string, object>, React.Dispatch<Record<string, object>>]}
   */
  const [deployRuns, setDeployRuns] = useState({});
  /** @type {[object|null, React.Dispatch<object|null>]} deployment record being edited, or null */
  const [editingDeployment, setEditingDeployment] = useState(null);
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
  /** @type {['logs'|'metrics'|'deploy'|'manage', React.Dispatch<string>]} the active process tab */
  const [activeTab, setActiveTab] = useState('logs');
  const logRef = useRef(null);
  const autoStickRef = useRef(true);
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
  /** Mirrors `selection` for handlers that must not wait for a re-render. */
  const selectionRef = useRef(null);

  // Process-scoped requests and WebSocket subscriptions only ever see a
  // process key; a deployment key means no process is selected.
  const selectedProcessId = deploymentIdFromKey(selection) ? null : selection;
  const selectedDeploymentId = deploymentIdFromKey(selection);

  /**
   * Change what the content area shows.
   *
   * A different selection opens `tab` (Logs unless given); selecting what is
   * already shown keeps the current tab unless one is given.
   *
   * @param {number|string|null} key - See `selection`.
   * @param {'logs'|'metrics'|'deploy'|'manage'} [tab]
   */
  const select = useCallback((key, tab) => {
    if (tab) setActiveTab(tab);
    else if (String(selectionRef.current) !== String(key)) setActiveTab('logs');
    selectionRef.current = key;
    setSelection(key);
    setDrawerOpen(false);
  }, []);

  const loadProcesses = useCallback(async () => {
    try {
      const payload = await fetchJson('/api/processes');
      setProcesses(payload.items);
      setSelection((prev) => keepSelection(payload.items, prev));
    } catch (loadError) {
      setProcesses([]);
      setSelection(null);
      setError(loadError.message);
    }
  }, []);

  /** Reload the deployment records. Resolves once the list is in state. */
  const loadDeployments = useCallback(
    () =>
      fetchJson('/api/deployments')
        .then((payload) => {
          setDeployments(payload.deployments || []);
          setDeploymentsLoaded(true);
        })
        .catch((loadError) => setError(`Failed to load deployments: ${loadError.message}`)),
    [],
  );

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

  // Poll host metrics every 20 s to keep the host charts current without a page refresh.
  useEffect(() => {
    const interval = setInterval(loadHostMetrics, 20_000);
    return () => clearInterval(interval);
  }, [loadHostMetrics]);

  useEffect(() => {
    selectedProcessIdRef.current = selectedProcessId;
  }, [selectedProcessId]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

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
        // Counted here rather than from liveLines.length, which stops growing
        // once the 800-line cap is reached.
        if (!autoStickRef.current) setUnreadLogCount((prev) => prev + queued.length);
      }
    };
    /**
     * True when a process-scoped message belongs to the current selection.
     * Messages still in flight for the previously selected process are dropped.
     *
     * @param {{ processId?: string }} data
     */
    const isForSelection = (data) => String(data?.processId) === String(selectedProcessIdRef.current);
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
            setSelection((prev) => keepSelection(data.items, prev));
            if (data.hostCurrent !== undefined) setHostCurrent(data.hostCurrent);
          } else if (type === 'details') {
            if (isForSelection(data)) setDetails(data);
          } else if (type === 'snapshot') {
            if (isForSelection(data)) {
              setLiveLines(data.lines.map((l, index) => ({ key: `snapshot-${index}`, text: l.text })));
            }
          } else if (type === 'log') {
            if (!isForSelection(data)) return;
            liveSequenceRef.current += 1;
            queueLiveLine({ key: `live-${liveSequenceRef.current}`, text: data.text });
          } else if (type === 'error') {
            setError(data.error);
          } else if (type === 'deploy_progress') {
            // Every deployment's progress is kept, including deploys the branch
            // watcher starts in the background and a new deployment whose id
            // the POST response has not delivered yet.
            setDeployRuns((runs) => recordDeployEvent(runs, data));
            if (data.stage === 'done' || data.stage === 'error') loadDeployments();
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
  }, [loadDeployments]);

  // Derived: the full process object for the current selection (handles orphans with id=null).
  const selectedProcess = useMemo(
    () => processes.find((item) => String(processKey(item)) === String(selectedProcessId)) || null,
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
   * Deployments that exist in the DB but have no PM2 process. They are listed
   * in the sidebar and open their own page; see offlineStatus in
   * services/deployment.js for how their state is told apart.
   *
   * The stored `deploying` flag is only reloaded when a run ends, so a run
   * this client sees in progress marks its deployment as deploying too.
   *
   * @type {object[]}
   */
  const offlineDeployments = useMemo(() => {
    const pm2Names = new Set(processes.map((p) => p.name));
    return deployments
      .filter((d) => !pm2Names.has(d.pm2_name))
      .map((d) => (!d.deploying && isRunActive(d, deployRuns[d.id]) ? { ...d, deploying: 1 } : d));
  }, [deployments, processes, deployRuns]);

  /** The offline deployment whose page is open, or null. */
  const selectedOfflineDeployment = useMemo(
    () => (selectedDeploymentId ? (offlineDeployments.find((d) => d.id === selectedDeploymentId) ?? null) : null),
    [offlineDeployments, selectedDeploymentId],
  );

  // A deployment key stays valid while its deployment has no PM2 process. Once
  // PM2 has the process (a first deploy reached its start step) the selection
  // moves to that process with its Deploy tab open, so the run stays in view;
  // a deleted deployment falls back to the Overview.
  useEffect(() => {
    if (!selectedDeploymentId || !deploymentsLoaded) return;
    const deployment = deployments.find((d) => d.id === selectedDeploymentId);
    if (!deployment) {
      select(null);
      return;
    }
    const proc = processes.find((p) => p.name === deployment.pm2_name);
    if (proc) select(processKey(proc), 'deploy');
  }, [selectedDeploymentId, deployments, deploymentsLoaded, processes, select]);

  /** Everything the Overview lists under Needs attention, also counted in the sidebar. */
  const attentionItems = useMemo(
    () => buildAttentionItems({ processes, offlineDeployments, deployments, deployRuns, hostCurrent }),
    [processes, offlineDeployments, deployments, deployRuns, hostCurrent],
  );

  /**
   * Load the stored CPU/memory and application metric history of a process.
   *
   * @param {string|number} processId
   * @param {AbortSignal} signal
   * @param {string} failureLabel - Start of the error banner text.
   */
  const loadMetrics = useCallback((processId, signal, failureLabel) => {
    fetchJson(`/api/processes/${encodeURIComponent(processId)}/metrics`, { signal })
      .then((payload) => {
        setMetricsHistory(payload.samples || []);
        setCustomMetricsHistory(payload.custom || []);
      })
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') setError(`${failureLabel}: ${loadError.message}`);
      });
  }, []);

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
    setCustomMetricsHistory([]);
    setUnreadLogCount(0);
    // Held lines belong to the process we are leaving, so they are dropped
    // rather than flushed into the next one's stream.
    pausedBufferRef.current = [];
    liveQueueRef.current = [];
    liveSequenceRef.current = 0;
    if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
    liveFrameRef.current = null;
    setPausedCount(0);
    autoStickRef.current = true;
    setLogSearch('');

    if (selectedProcessId === null || selectedProcessId === undefined) {
      return () => controller.abort();
    }

    loadMetrics(selectedProcessId, controller.signal, 'Failed to load metrics');

    fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/actions`, { signal: controller.signal })
      .then((payload) => setActions(payload.actions || []))
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') setError(`Failed to load actions: ${loadError.message}`);
      });
    return () => controller.abort();
  }, [selectedProcessId, loadMetrics]);

  const selectedIsOnline = String(selectedProcess?.status ?? '').toLowerCase() === 'online';
  const selectedUptime = details?.process?.uptime ?? null;

  // Ask the selected process for its log level. Only a running process can
  // answer, so a stopped one is not asked at all, and keying on its start time
  // asks again after a restart, which puts the process back on its boot level.
  useEffect(() => {
    setLogLevel({ supported: null, level: null, busy: false });
    if (selectedProcessId == null || !selectedIsOnline || selectedUptime == null) return undefined;
    const controller = new AbortController();
    fetchJson(`/api/processes/${encodeURIComponent(selectedProcessId)}/log-level`, { signal: controller.signal })
      .then((payload) => setLogLevel({ supported: payload.supported, level: payload.level, busy: false }))
      .catch((loadError) => {
        if (loadError.name === 'AbortError') return;
        setLogLevel({ supported: false, level: null, busy: false });
        // 404 and 409 mean the process vanished or stopped in the meantime; the
        // next list update hides the section, so there is nothing to report.
        if (loadError.status !== 404 && loadError.status !== 409) {
          setError(`Failed to load the log level: ${loadError.message}`);
        }
      });
    return () => controller.abort();
  }, [selectedProcessId, selectedIsOnline, selectedUptime]);

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

  // Poll metrics every 20 s (matching the scheduler interval) so the charts
  // update in real time without requiring a page refresh.
  useEffect(() => {
    if (selectedProcessId === null || selectedProcessId === undefined || !isSelectedMonitored) return;
    let controller = null;
    const interval = setInterval(() => {
      controller?.abort();
      controller = new AbortController();
      loadMetrics(selectedProcessId, controller.signal, 'Failed to refresh metrics');
    }, 20_000);
    return () => {
      clearInterval(interval);
      controller?.abort();
    };
  }, [selectedProcessId, isSelectedMonitored, loadMetrics]);

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

  // Coming back to the Logs tab mounts a fresh viewer at its top, so start
  // following the stream again instead of showing the oldest line.
  useEffect(() => {
    autoStickRef.current = true;
    setUnreadLogCount(0);
  }, [activeTab]);

  // Follow new lines while the user is parked at the bottom. Appending lines
  // fires no scroll event, so the stick flag only changes when the user
  // scrolls. details updates every 3 s and must not be in deps, otherwise the
  // viewer would jump to the bottom while the user reads older lines.
  useEffect(() => {
    const container = logRef.current;
    if (container && autoStickRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [storedLogs, liveLines, activeTab]);

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
        if (!autoStickRef.current) setUnreadLogCount((prev) => prev + buffered.length);
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
   * The readouts in the process header are shortcuts into this tab, not chart
   * surfaces of their own: every process chart is drawn once, in MetricsPanel.
   *
   * @param {string} [chartId] - id of the target chart card, e.g. 'metric-cpu'.
   */
  const showMetric = useCallback((chartId) => {
    setActiveTab('metrics');
    // The panel only mounts once the tab switches, so wait for it to be painted.
    if (chartId) scrollToWhenRendered(chartId);
  }, []);

  /** Open the Overview and scroll to its host charts. */
  const showHost = useCallback(() => {
    select(null);
    scrollToWhenRendered('host');
  }, [select]);

  /**
   * Open a deployment: the Deploy tab of its process, or its own page when it
   * has no PM2 process.
   *
   * @param {string} deploymentId
   */
  const openDeployment = useCallback(
    (deploymentId) => {
      const deployment = deployments.find((d) => d.id === deploymentId);
      const proc = deployment && processes.find((p) => p.name === deployment.pm2_name);
      select(proc ? processKey(proc) : deploymentKey(deploymentId), 'deploy');
    },
    [deployments, processes, select],
  );

  /**
   * Record a failure that happened in the browser (the request never reached
   * the deploy runner) as the end of the deployment's run.
   *
   * @param {string} deploymentId
   * @param {string} message
   */
  const failRun = useCallback((deploymentId, message) => {
    setDeployRuns((runs) => recordDeployEvent(runs, { deploymentId, stage: 'error', line: message, status: 'error' }));
  }, []);

  /**
   * Redeploy a deployment with its saved configuration, without a form. The
   * run shows in the Deploy tab as its progress arrives.
   *
   * @param {object} deployment - Deployment record.
   */
  const onRedeploy = useCallback(
    async (deployment) => {
      setDeployRuns((runs) =>
        startRun(runs, deployment.id, {
          firstDeploy: deployment.last_deployed_at == null,
          startsProcess: !processes.some((p) => p.name === deployment.pm2_name),
        }),
      );
      try {
        await fetchWithCsrf(`/api/deployments/${deployment.id}/redeploy`, {
          onCsrfRefresh: refreshCsrf,
          method: 'POST',
        });
      } catch (err) {
        failRun(deployment.id, err.message);
      }
    },
    [refreshCsrf, failRun, processes],
  );

  /**
   * Called by DeployModal once the server has accepted a new deployment.
   * Closes the modal and opens the deployment's page, which shows the run.
   * Progress that arrived before the id was known is already in deployRuns.
   *
   * @param {string} deploymentId
   */
  const onDeployStarted = useCallback(
    async (deploymentId) => {
      setDeployOpen(false);
      setEditingDeployment(null);
      setDeployRuns((runs) => (runs[deploymentId] ? runs : startRun(runs, deploymentId, { firstDeploy: true })));
      // The page needs the record, so wait for it before selecting.
      await loadDeployments();
      select(deploymentKey(deploymentId), 'deploy');
    },
    [loadDeployments, select],
  );

  /**
   * Called by DeployModal after "Save and redeploy" has saved the
   * configuration (PUT): closes the modal, opens the Deploy tab and starts
   * the redeploy.
   *
   * @param {string} deploymentId - UUID of the deployment record.
   */
  const onSaveAndRedeploy = useCallback(
    async (deploymentId) => {
      const deployment = deployments.find((d) => d.id === deploymentId);
      setDeployOpen(false);
      setEditingDeployment(null);
      openDeployment(deploymentId);
      loadDeployments();
      if (deployment) await onRedeploy(deployment);
    },
    [deployments, openDeployment, loadDeployments, onRedeploy],
  );

  /**
   * Answer a deployment that waits for confirmation: discard the local
   * changes and continue, or cancel it.
   *
   * @param {string} deploymentId
   * @param {boolean} confirmed - True to discard local changes and continue; false to cancel.
   */
  const onConfirmDeploy = useCallback(
    async (deploymentId, confirmed) => {
      try {
        await fetchWithCsrf(`/api/deployments/${deploymentId}/confirm`, {
          onCsrfRefresh: refreshCsrf,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed }),
        });
      } catch (err) {
        failRun(deploymentId, err.message);
      }
    },
    [refreshCsrf, failRun],
  );

  /**
   * Hide a finished run, so the Deploy tab shows the configuration alone.
   *
   * @param {string} deploymentId
   */
  const onDismissRun = useCallback((deploymentId) => {
    setDeployRuns((runs) =>
      runs[deploymentId] ? { ...runs, [deploymentId]: { ...runs[deploymentId], dismissed: true } } : runs,
    );
  }, []);

  /**
   * Open the deploy modal in edit mode for a deployment.
   *
   * @param {object} deployment - Deployment record.
   */
  const onEditDeployment = useCallback((deployment) => {
    setEditingDeployment(deployment);
    setDeployOpen(true);
  }, []);

  /**
   * Delete a deployment record without touching PM2 or the files on disk.
   * Used for deployments that have no PM2 process.
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
        await loadDeployments();
      } catch (err) {
        setError(err.message);
      }
    },
    [csrfToken, refreshCsrf, loadDeployments],
  );

  /**
   * Called after a deployment record has been saved without redeploying.
   * Reloads the deployments list and closes the modal.
   */
  const onEditSaved = useCallback(async () => {
    loadDeployments();
    setDeployOpen(false);
    setEditingDeployment(null);
  }, [loadDeployments]);

  /**
   * Run a PM2 lifecycle command on the selected process. Stop keeps the process
   * in PM2 with a `stopped` status, so it can be started again.
   *
   * @param {'restart'|'stop'|'start'} command
   */
  const runProcessCommand = async (command) => {
    if (selectedProcessId === null || selectedProcessId === undefined || !csrfToken) {
      return;
    }
    try {
      await fetchWithCsrf(`/api/processes/${encodeURIComponent(selectedProcessId)}/${command}`, {
        onCsrfRefresh: refreshCsrf,
        method: 'POST',
      });
    } catch (commandError) {
      setError(commandError.message);
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
      select(null);
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
      // If the orphan was selected, go back to the Overview.
      if (String(selectionRef.current) === pm2Name) select(null);
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
        // Debug and trace lines need no filter change: the level filter only
        // ever hides info, warn and error lines.
        setLogLevel({ supported: payload.supported, level: payload.level, busy: false });
      } catch (err) {
        if (String(selectedProcessIdRef.current) !== String(processId)) return;
        setLogLevel((prev) => ({ ...prev, busy: false }));
        setError(err.message);
      }
    },
    [csrfToken, selectedProcessId, refreshCsrf],
  );

  const isSelectedOrphan = selectedProcess?.isOrphan ?? false;
  /** Deployment shown in the Deploy tab or on the offline deployment page. */
  const shownDeployment = selectedOfflineDeployment ?? (isSelectedOrphan ? null : selectedDeployment);
  const shownRun = shownDeployment ? deployRuns[shownDeployment.id] : undefined;
  const deployDot = deployTabDot(shownDeployment, shownRun);
  const tabs = TABS.filter((tab) => tab.id !== 'deploy' || shownDeployment);
  // A tab that does not exist for this process (Deploy after a removal) falls back to Logs.
  const visibleTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'logs';

  /**
   * The tab strip under a header.
   *
   * @param {{ id: string, label: string }[]} list
   * @param {string} current - id of the selected tab.
   */
  const renderTabs = (list, current) => (
    <div className="tabs" role="tablist" aria-label="Process views">
      {list.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={current === tab.id}
          aria-controls={`panel-${tab.id}`}
          className="tab"
          onClick={() => setActiveTab(tab.id)}
        >
          {tab.label}
          {tab.id === 'logs' && allLines.length > 0 && (
            <span className="tab-count">{allLines.length.toLocaleString('en-US')}</span>
          )}
          {tab.id === 'deploy' && deployDot && (
            <span className="tab-dot" data-tone={deployDot.tone} title={deployDot.label} />
          )}
          {tab.id === 'manage' && !isSelectedMonitored && (
            <span className="tab-flag" title="Monitoring is off for this process" />
          )}
        </button>
      ))}
    </div>
  );

  const deployPanel = shownDeployment && (
    <DeployPanel
      deployment={shownDeployment}
      run={shownRun}
      hasProcess={!selectedOfflineDeployment}
      onRedeploy={onRedeploy}
      onEdit={onEditDeployment}
      onConfirm={onConfirmDeploy}
      onDismiss={onDismissRun}
      onOpenLogs={() => setActiveTab('logs')}
      onDelete={onDeleteDeployment}
    />
  );

  let content;
  if (selectedOfflineDeployment) {
    content = (
      <>
        <ProcessHeader offlineDeployment={selectedOfflineDeployment}>
          {renderTabs([{ id: 'deploy', label: 'Deploy' }], 'deploy')}
        </ProcessHeader>
        <div className="tab-panel tab-panel--scroll" role="tabpanel" id="panel-deploy" aria-labelledby="tab-deploy">
          {deployPanel}
        </div>
      </>
    );
  } else if (selectedProcess) {
    content = (
      <>
        <ProcessHeader
          selectedProcess={selectedProcess}
          details={details}
          selectedDeployment={selectedDeployment}
          onRestart={() => runProcessCommand('restart')}
          onStop={() => runProcessCommand('stop')}
          onStart={() => runProcessCommand('start')}
          onOpenDeploy={() => setActiveTab('deploy')}
          onShowMetrics={showMetric}
        >
          {renderTabs(tabs, visibleTab)}
        </ProcessHeader>

        <div
          className={visibleTab === 'logs' ? 'tab-panel' : 'tab-panel tab-panel--scroll'}
          role="tabpanel"
          id={`panel-${visibleTab}`}
          aria-labelledby={`tab-${visibleTab}`}
        >
          {visibleTab === 'logs' && (
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

          {visibleTab === 'metrics' && (
            <MetricsPanel
              processName={selectedProcess.name}
              details={details}
              metricsHistory={metricsHistory}
              customMetricsHistory={customMetricsHistory}
              hostSamples={hostMetrics}
              isMonitored={isSelectedMonitored}
              metricsRetentionMs={appConfig?.metricsRetentionMs}
              memoryLimit={selectedDeployment?.pm2_options?.max_memory_restart}
              onEnableMonitoring={() => onToggleMonitoring(selectedProcess.name, false)}
              onShowHost={showHost}
            />
          )}

          {visibleTab === 'deploy' && deployPanel}

          {visibleTab === 'manage' && (
            <ManagePanel
              selectedProcess={selectedProcess}
              isMonitored={isSelectedMonitored}
              metricsRetentionMs={appConfig?.metricsRetentionMs}
              logsRetentionMs={appConfig?.logsRetentionMs}
              onToggleMonitoring={onToggleMonitoring}
              onToggleAlerts={onToggleAlerts}
              onOpenAlerting={() => setSettingsPage('Alerting')}
              actions={actions}
              logLevel={logLevel}
              onSetLogLevel={onSetLogLevel}
              selectedProcessId={selectedProcessId}
              csrfToken={csrfToken}
              onCsrfRefresh={refreshCsrf}
              selectedDeployment={selectedDeployment}
              onDelete={onDelete}
              onRemoveOrphan={onRemoveOrphan}
            />
          )}
        </div>
      </>
    );
  } else {
    content = (
      <Overview
        processes={processes}
        offlineCount={offlineDeployments.length}
        attentionItems={attentionItems}
        hostSamples={hostMetrics}
        hostCurrent={hostCurrent}
        metricsRetentionMs={appConfig?.metricsRetentionMs}
        onOpenLogs={(key) => select(key, 'logs')}
        onOpenDeployment={openDeployment}
        onShowHost={showHost}
      />
    );
  }

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

          <a
            className="topbar-brand"
            href="/"
            aria-label="pm2-hawkeye home"
            onClick={(e) => {
              e.preventDefault();
              select(null);
            }}
          >
            <span className="topbar-brand-logo">
              <Eye size={15} weight="bold" color="var(--accent)" />
            </span>
            <span className="topbar-brand-wordmark">
              <span className="brand-pm2">pm2</span>
              <span className="brand-hawkeye">-hawkeye</span>
            </span>
          </a>

          <HostMetrics samples={hostMetrics} current={hostCurrent} onShowHost={showHost} />
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
              aria-label="New deployment"
              onClick={() => {
                setEditingDeployment(null);
                setDeployOpen(true);
              }}
            >
              <Plus size={13} weight="bold" />
              {/* The label is hidden on narrow viewports; the aria-label carries it. */}
              <span>New deployment</span>
            </button>
            <button
              className="btn btn--icon"
              type="button"
              title="Settings"
              aria-label="Settings"
              onClick={() => setSettingsPage('General')}
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
          selection={selection}
          onSelect={(key) => select(key)}
          deployedNames={deployedNames}
          offlineDeployments={offlineDeployments}
          attentionCount={attentionItems.length}
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

          {content}
        </main>

        <Footer version={appVersion} />

        {settingsPage && (
          <Settings
            initialPage={settingsPage}
            onClose={() => setSettingsPage(null)}
            csrfToken={csrfToken}
            onCsrfRefresh={refreshCsrf}
          />
        )}

        {deployOpen && (
          <DeployModal
            onCsrfRefresh={refreshCsrf}
            deployBaseDir={appConfig?.deployBaseDir}
            onClose={() => {
              setDeployOpen(false);
              setEditingDeployment(null);
            }}
            onDeployStarted={onDeployStarted}
            editingDeployment={editingDeployment}
            onEditSaved={onEditSaved}
            onSaveAndRedeploy={onSaveAndRedeploy}
          />
        )}
      </div>
    </IconContext.Provider>
  );
}
