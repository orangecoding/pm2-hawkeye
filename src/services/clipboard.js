/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Copy text to the clipboard.
 *
 * Uses the Clipboard API where the browser offers it, which is only on HTTPS
 * and localhost. Hawkeye often runs on plain `http://host:3030`, where that
 * API is missing, so a selected, invisible textarea and the legacy copy
 * command take over there. The textarea goes into the open dialog when there
 * is one, so the dialog's focus trap does not pull focus away before the copy.
 *
 * @param {string} text
 * @returns {Promise<boolean>} True when the text was copied.
 */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied permission or similar: try the fallback.
    }
  }

  const previousFocus = document.activeElement;
  const host = previousFocus?.closest?.('[role="dialog"]') ?? document.body;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  host.appendChild(textarea);
  textarea.select();

  let copied;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  if (previousFocus instanceof HTMLElement) previousFocus.focus();
  return copied;
}
