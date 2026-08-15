/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { IconContext } from '@phosphor-icons/react';

export {
  ArrowDown,
  ArrowSquareOut,
  ChartLine,
  Check,
  CheckCircle,
  Copy,
  DownloadSimple,
  Eye,
  GearSix,
  GitBranch,
  List,
  MagnifyingGlass,
  TextAlignLeft,
  Pause,
  Play,
  Plus,
  Power,
  Record,
  RocketLaunch,
  SignOut,
  Stop,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react';

export { IconContext };

/**
 * Shared icon defaults.
 *
 * One family (Phosphor), one weight, one size, applied through context so no
 * component sets them individually. The app previously drew its glyphs by hand
 * at four different stroke widths.
 */
export const ICON_DEFAULTS = { size: 15, weight: 'bold' };
