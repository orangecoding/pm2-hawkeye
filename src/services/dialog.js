/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keep keyboard focus inside a modal, close it with Escape when allowed, and
 * restore focus to the control that opened it.
 *
 * @param {React.RefObject<HTMLElement|null>} containerRef
 * @param {(() => void)|null} onEscape
 */
export function useDialogFocus(containerRef, onEscape) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const container = containerRef.current;
    const previousFocus = document.activeElement;
    if (!container) return undefined;

    const focusable = () =>
      [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
        (element) => element.getAttribute('aria-hidden') !== 'true',
      );

    (focusable()[0] || container).focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && escapeRef.current) {
        event.preventDefault();
        escapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!container.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [containerRef]);
}
