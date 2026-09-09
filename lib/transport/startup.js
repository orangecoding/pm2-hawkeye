/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Start runtime services and launch historical log backfill only after the
 * HTTP listener and PM2 log bus are active.
 *
 * @param {{
 *   startLogBus: () => Promise<void>,
 *   startServices: () => void,
 *   listen: (callback: () => void) => void,
 *   backfill: () => Promise<void>,
 *   onBackfillError: (error: Error) => void,
 *   waitBeforeRetry?: () => Promise<void>,
 * }} operations
 * @returns {Promise<void>}
 */
export async function startRuntime({
  startLogBus,
  startServices,
  listen,
  backfill,
  onBackfillError,
  waitBeforeRetry = () =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    }),
}) {
  startServices();
  listen(() => {
    void (async () => {
      while (true) {
        try {
          await startLogBus();
          break;
        } catch (error) {
          onBackfillError(error);
          await waitBeforeRetry();
        }
      }

      try {
        await backfill();
      } catch (error) {
        onBackfillError(error);
      }
    })();
  });
}
