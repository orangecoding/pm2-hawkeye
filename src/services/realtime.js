/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Open a WebSocket that reconnects with capped exponential backoff until its
 * owner closes it.
 *
 * @param {{
 *   url: string,
 *   onMessage: (event: MessageEvent) => void,
 *   onStateChange: (connected: boolean) => void,
 *   onSocket: (socket: WebSocket|null) => void,
 *   onOpen?: (socket: WebSocket) => void,
 *   WebSocketImpl?: typeof WebSocket,
 *   schedule?: typeof setTimeout,
 *   cancel?: typeof clearTimeout,
 * }} options
 * @returns {{ close: () => void }}
 */
export function createReconnectingWebSocket({
  url,
  onMessage,
  onStateChange,
  onSocket,
  onOpen,
  WebSocketImpl = WebSocket,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let stopped = false;
  let socket = null;
  let retryTimer = null;
  let stableTimer = null;
  let retryAttempt = 0;

  const connect = () => {
    if (stopped) return;
    const current = new WebSocketImpl(url);
    socket = current;
    onSocket(current);
    current.onopen = () => {
      onStateChange(true);
      onOpen?.(current);
      stableTimer = schedule(() => {
        stableTimer = null;
        retryAttempt = 0;
      }, 10_000);
    };
    current.onmessage = onMessage;
    current.onerror = () => {
      onStateChange(false);
      current.close();
    };
    current.onclose = () => {
      onStateChange(false);
      if (stableTimer !== null) cancel(stableTimer);
      stableTimer = null;
      if (socket === current) {
        socket = null;
        onSocket(null);
      }
      if (stopped || retryTimer !== null) return;
      const delay = Math.min(500 * 2 ** retryAttempt, 10_000);
      retryAttempt += 1;
      retryTimer = schedule(() => {
        retryTimer = null;
        connect();
      }, delay);
    };
  };

  connect();

  return {
    close() {
      stopped = true;
      if (retryTimer !== null) cancel(retryTimer);
      if (stableTimer !== null) cancel(stableTimer);
      retryTimer = null;
      stableTimer = null;
      socket?.close();
      socket = null;
      onSocket(null);
    },
  };
}
