/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { IconContext } from '@phosphor-icons/react';

export {
  ArrowClockwise,
  ArrowDown,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Copy,
  DownloadSimple,
  Eye,
  GearSix,
  GitBranch,
  Info,
  List,
  MagnifyingGlass,
  Pause,
  PencilSimple,
  Play,
  Plus,
  Record,
  RocketLaunch,
  SignOut,
  SquaresFour,
  Warning,
  WarningCircle,
  X,
} from '@phosphor-icons/react';

export { IconContext };

/**
 * Shared icon defaults.
 *
 * One family (Phosphor) with one default size and weight, applied through
 * context. Components pass `size` where their layout needs a smaller glyph,
 * and `weight="fill"` only for solid status marks. The app previously drew
 * its glyphs by hand at four different stroke widths.
 */
export const ICON_DEFAULTS = { size: 15, weight: 'bold' };
