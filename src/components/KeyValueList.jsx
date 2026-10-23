/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import { Plus, X } from './Icon.jsx';

/**
 * Editable list of key/value pairs: deployment environment variables, webhook
 * headers and webhook body params.
 *
 * @param {{
 *   label: string,
 *   hint?: string,
 *   rows: { key: string, value: string }[],
 *   keyPlaceholder: string,
 *   valuePlaceholder: string,
 *   itemLabel?: string,
 *   addLabel?: string,
 *   onAdd: () => void,
 *   onUpdate: (index: number, field: 'key' | 'value', value: string) => void,
 *   onRemove: (index: number) => void,
 * }} props - `itemLabel` names one row for screen readers (defaults to
 *   `label`), `addLabel` is the text of the add button.
 */
export default function KeyValueList({
  label,
  hint,
  rows,
  keyPlaceholder,
  valuePlaceholder,
  itemLabel = label,
  addLabel = 'Add',
  onAdd,
  onUpdate,
  onRemove,
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <p className="hint">{hint}</p>}
      {rows.map((row, i) => (
        <div className="kv-row" key={i}>
          <input
            className="input"
            type="text"
            placeholder={keyPlaceholder}
            aria-label={`${itemLabel} name ${i + 1}`}
            value={row.key}
            onChange={(e) => onUpdate(i, 'key', e.target.value)}
          />
          <input
            className="input"
            type="text"
            placeholder={valuePlaceholder}
            aria-label={`${itemLabel} value ${i + 1}`}
            value={row.value}
            onChange={(e) => onUpdate(i, 'value', e.target.value)}
          />
          <button
            type="button"
            className="btn btn--icon"
            aria-label={`Remove ${itemLabel.toLowerCase()} ${i + 1}`}
            onClick={() => onRemove(i)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn--sm" onClick={onAdd}>
        <Plus size={12} weight="bold" />
        {addLabel}
      </button>
    </div>
  );
}
