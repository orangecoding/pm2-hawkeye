/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Centralised HTTP helpers for the PM2 dashboard.
 */

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('Session expired.');
  }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

/**
 * Send a state-changing request and refresh its single-use CSRF token whether
 * the request succeeds or fails.
 *
 * @param {string} url
 * @param {{ onCsrfRefresh: () => Promise<string>, onCsrfRefreshError?: (error: Error) => void } & RequestInit} options
 * @returns {Promise<object>}
 */
let csrfMutationQueue = Promise.resolve();

export function fetchWithCsrf(url, { onCsrfRefresh, onCsrfRefreshError, headers, ...options }) {
  const execute = async () => {
    const csrfToken = await onCsrfRefresh();
    let result;
    let requestError;
    try {
      result = await fetchJson(url, {
        ...options,
        headers: { ...headers, 'X-CSRF-Token': csrfToken },
      });
    } catch (error) {
      requestError = error;
    }

    try {
      await onCsrfRefresh();
    } catch (refreshError) {
      if (onCsrfRefreshError) onCsrfRefreshError(refreshError);
      else console.warn(`Failed to refresh the CSRF token after ${options.method || 'request'} ${url}:`, refreshError);
    }

    if (requestError) throw requestError;
    return result;
  };

  const queued = csrfMutationQueue.then(execute, execute);
  csrfMutationQueue = queued.catch(() => undefined);
  return queued;
}
