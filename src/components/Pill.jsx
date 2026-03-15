/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from "react";

export default function Pill({ label, tone = "muted", className = "" }) {
  return <span className={`pill ${tone} ${className}`.trim()}>{label}</span>;
}
