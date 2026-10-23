# Hawkeye UI redesign: implementation handoff

This document is the brief for implementing the redesigned pm2-hawkeye UI so it matches the
design pixel for pixel. Read all of it before you change code.

## 0. How to work

- **Read `CLAUDE.md` first.** Every rule there applies: graft before grep or read, JSDoc on
  everything you touch, ESM, single quotes, LESS tokens from `src/styles/variables.less`,
  icons only from `src/components/Icon.jsx`, confirmations only through `ConfirmButton`,
  no em dashes anywhere, never commit unless the user says "commit", never use git worktrees.
- **Design source.** Canvas: https://claude.ai/artifact/4RX2ZSGTPDuW9iozohpiPs (private to the
  owner). Local copies of every artboard: `docs/redesign/screens/*.dc.html`. The `style="..."`
  attributes in those files are the exact spec for sizes, colors, spacing and type. They need the
  canvas runtime and do not render as plain HTML. Treat each `renderVals()` block as **sample
  data**, never as copy or logic to port. Exception: the `chart()` method in `Main.dc.html`
  and `ProcessMetrics.dc.html` is a good reference for the chart geometry.
- **Artboard → screen map**

  | Artboard file | Screen |
  |---|---|
  | `Main.dc.html` | Overview, the new home (nothing selected) |
  | `ProcessLogs.dc.html` | Process: Logs tab |
  | `ProcessMetrics.dc.html` | Process: Metrics tab |
  | `ProcessManage.dc.html` | Process: Manage tab |
  | `ProcessDeploy.dc.html` | Process: Deploy tab, idle |
  | `DeployRunning.dc.html` | Deploy tab while a run is active. Tweak `state` = `running`, `confirm`, `failed`, `success` |
  | `DeployFailed.dc.html` | A deployment that has no PM2 process (first deploy failed) |
  | `NewDeployment.dc.html` | New deployment modal. Tweak `mode` = `new` or `edit` |

- **Hex and px → tokens.** The design uses literal values; implement them with tokens:

  | Design value | Token |
  |---|---|
  | `#0b0b0d` / `#111114` / `#17171b` / `#1e1e23` | `--bg-0` / `--bg-1` / `--bg-2` / `--bg-3` |
  | `rgba(255,255,255,0.07)` / `0.14` | `--border` / `--border-strong` |
  | `#ededf0` / `#a7a7ae` / `#8a8a92` | `--text` / `--text-dim` / `--muted` (new value, see 2.1) |
  | `#c4c4cc` | `--log-default` |
  | `#fd8c66`, `rgba(253,140,102,0.12)`, `0.34`, `#1a0d07`, `#ffa383` | `--accent`, `--accent-soft`, `--accent-line`, `--on-accent`, `--accent-hover` |
  | `#34d399` / `#fbbf24` / `#f87171` / `#60a5fa` and their `0.13` soft fills | `--success` / `--warning` / `--critical` / `--info` and `*-soft` |
  | radius 4px / 8px | `--r-1` / `--r-2` (circles stay `50%`) |
  | 4, 8, 12, 16, 20, 24, 32 px | `--s-1`, `--s-2`, `--s-3`, `--s-4`, `--s-5`, `--s-6`, `--s-8` |

  The space lock wins over the canvas where they disagree. Design values that are off the 4px
  scale snap like this: **2px stays** (precedent: `0.125rem`), **6px → 8px**, **10px → 12px**,
  **14px → 16px**. New translucent values that have no token yet are listed per screen below.
  Add them as tokens in `variables.less` rather than inlining them.

- **Suggested order:** tokens and icons → navigation model and sidebar → Overview →
  `TimeSeriesChart` and Metrics → Manage → Deploy tab and run panel → deploy modal → backend
  field → docs. After each step, run `npm run lint`, `npm run format:check` and `npm test`.

## 1. Why

- There was no overview. The landing state was a "No process selected" card.
- Host CPU, RAM and disk were only charted inside each process's Metrics tab, repeated per
  process.
- Deployment was scattered across six places: a header Redeploy button, the header chip, a
  section in Manage, sidebar rows with their own buttons, the modal form and the modal progress
  view. "Redeploy" opened a configuration form instead of redeploying.
- The sidebar mixed picking a process with acting on deployments, which breaks the app's rule:
  pick an object, then act on it.

## 2. Global changes

### 2.1 Tokens

- `--muted: #77777f` → `#8a8a92`. The old value has 4.2:1 contrast on `--bg-1`, below the 4.5:1
  minimum. The new one has 5.5:1 on `--bg-1` and 5.2:1 on `--bg-2`. Update the comment.
- New tokens, with the names up to you, matching the existing naming:
  - chart hairline `rgba(255,255,255,0.05)`;
  - chart baseline `rgba(255,255,255,0.1)`;
  - chart crosshair `rgba(255,255,255,0.28)`;
  - log error row tint `rgba(248,113,113,0.06)`;
  - warning callout fill `rgba(251,191,36,0.06)` with line `rgba(251,191,36,0.34)`;
  - critical callout fill `rgba(248,113,113,0.06)` with line `rgba(248,113,113,0.34)`;
  - tooltip shadow `0 6px 16px rgba(6,6,8,0.6)`.

### 2.2 Icons

Add these Phosphor exports to `Icon.jsx`: `SquaresFour` (Overview), `ArrowClockwise` (Redeploy
now), `PencilSimple` (Edit configuration), `CaretRight` (option rows), `CircleNotch` (running
spinner), `Warning` (warning items), `Info` (hint line). Drop `RocketLaunch` from the top bar,
where it becomes `Plus`, but keep it for the "Deploy" and "Deploy again" buttons. Remove exports
that end up unused, such as `TextAlignLeft` from the old welcome card.

### 2.3 Navigation model (App.jsx)

- **Overview = no selection.** `selectedProcessId === null` renders the Overview. The welcome
  card and its CSS go away.
- **Initial selection is `null`.** `keepSelection` falls back to `null` when the selected
  process disappears. Today it falls back to the first process.
- **Offline deployments become selectable.** A deployment with no PM2 process (today rendered
  under "Not deployed" with buttons) is a normal row. Give it a selection key that cannot collide
  with a pm_id or a process name, for example `deployment:<uuid>`. Selecting it renders screen
  3.7. Process-scoped WS subscriptions and fetches must ignore such keys.
- The sidebar Overview row and the brand link set the selection to `null`.

### 2.4 Top bar (`App.jsx`, `layout.less`, `HostMetrics.jsx`)

Layout is unchanged except:

- The **host readout** is always a link. It sets the selection to `null` and scrolls to the
  Overview host section (`#host`). Today it only links when a process is selected and jumps
  into that process's Metrics tab.
- The **Deploy** button becomes **New deployment**: `btn--primary btn--sm`, `Plus` icon 13px,
  label hidden on narrow screens as today.
- Icon buttons are 32×32 with the 15px icon (`btn--icon`, unchanged).

### 2.5 Sidebar (`ProcessList.jsx`, `process-list.less`)

Spec: the `<aside>` in any artboard.

- **Nav block** on top: padding 8px 4px, bottom border. One row, **Overview**: 32px high,
  padding 0 8px, `--r-1`, 13px/500, `SquaresFour` 15px.
  - Active (Overview shown): `--bg-3` background, `--text`, icon in `--accent`.
  - Inactive: transparent background, `--text-dim`, icon inherits the text color.
  - Right side: an attention count badge, 18px tall, min-width 18px, padding 0 6px→8px,
    `--critical-soft` on `--critical`, 11px/600. It shows the number of Overview attention
    items (3.1) and is hidden at 0.
- **Processes header:** padding 12px 12px 4px. Section label "PROCESSES" (11px/600,
  letter-spacing 0.08em, uppercase, `--muted`) plus a mono count. The filter input (30px,
  `--bg-2`, search icon 13px) shows under the same condition as today (more than 6 entries).
- **Groups:** **Running** (status `online`) and **Not running** (every other status plus
  offline deployments). The "Not deployed" group goes away. Group head padding 12px 12px 6px→8px
  (16px top for the second group).
- **Rows:** a `<button>` with no nested buttons, 32px high, margin 0 4px 1px, padding 0 8px,
  grid `7px minmax(0,1fr) auto`, gap 8px.
  - Selected row: `--bg-3`. Hover: `--bg-3`.
  - Name: 13px/500. Running rows use `--text`, not-running rows `--text-dim`.
  - A 10px `GitBranch` after the name marks processes deployed by Hawkeye.
  - Running rows end with mono 11px CPU and memory in `--muted`, plus the 9px `--accent`
    record dot when monitored (unchanged).
  - Not-running rows end with a tag instead: 18px, padding 0 6px→8px, 11px/600:
    - errored / error: "Errored" (critical);
    - stopped: "Stopped" (`--bg-3` on `--text-dim`);
    - launching / one-launch-status: "Starting" (warning soft);
    - offline deployment deploying: "Deploying" (accent soft);
    - offline deployment broken: "Deploy failed" (critical);
    - offline deployment offline: "Not in PM2" (neutral).
  - Status dot colors as today; offline deployments use critical when broken, accent when
    deploying, muted when offline.
- **Removed:** the Redeploy and Delete buttons on offline rows. They move to screen 3.7.

### 2.6 Process header (`ProcessHeader.jsx`)

- **Removed:** the **Redeploy** button.
- The **deploy chip** switches to the **Deploy** tab instead of opening the edit modal. Title:
  "Deployed by Hawkeye from <repo>. Open the Deploy tab."
- Restart and Stop/Start stay as they are, and so does the stat strip. Header padding becomes
  16px 20px 0, matching the 20px content padding.

### 2.7 Tabs

- `TABS` becomes **Logs, Metrics, Deploy, Manage**. **Deploy** renders only when the process
  has a deployment and is not an orphan. Update the CLAUDE.md "three views" wording.
- Tab indicator dot (5px, after the label), first match wins:
  - accent while a run of this deployment is active (`deploying` or a live run in session);
  - warning while a run waits for confirmation or `watch_last_error` is set;
  - critical when the last run in this session failed;
  - none otherwise.
  The Manage "monitoring off" flag stays as it is.

## 3. Screens

### 3.1 Overview (`Main.dc.html`)

A new component, e.g. `Overview.jsx`, rendered by `App.jsx` when nothing is selected. Content
padding 20px, vertical gap 24px, background `--bg-1`.

1. **Heading.** "Overview" 16px/650, line-height 24px. Subline 12px `--muted`:
   "N processes. X running, Y not running." N counts PM2 processes plus offline deployments.
2. **Needs attention card.**
   - Card: `--bg-2`, 1px `--border`, `--r-2`.
   - Head: padding 12px 16px, title 14px/600, count tag (critical soft).
   - Rows: grid `16px 1fr auto`, gap 12px, padding 10px→12px 16px, top border each. Each row
     has an icon (16px, `WarningCircle` fill critical, or `Warning` fill warning), a title
     (13px/600), a detail (12px `--muted`) and an action button (`btn--sm`, background
     `--bg-1`).
   - Items, critical first, then warning, then by name:

     | Condition (data source) | Level | Title | Detail | Action |
     |---|---|---|---|---|
     | process status `errored` | critical | "<name> is errored" | "<restarts> restarts. PM2 has stopped restarting it." | "Open logs" → select it, Logs tab |
     | offline deployment `broken` | critical | "<name> was never deployed successfully" | "Its first deployment failed, so nothing runs in PM2." | "Open deployment" → select it |
     | session run failed | critical | "<name>: redeploy failed at <Step>" | first error line, truncated | "Open deployment" → Deploy tab |
     | host cpu/ram/disk ≥ 90 (`hostCurrent`) | critical | "Disk is 91% full" / "RAM is 93% used" / "CPU is at 95%" | "421 of 460 GB used on this machine." (CPU: "Average across all cores.") | "Show host" → scroll to `#host` |
     | session run waiting for confirmation | warning | "<name>: deployment is waiting for you" | "Local changes in the deploy folder need a decision." | "Open deployment" |
     | deployment `watch_last_error` | warning | "<name> auto-deploy check failed" | "Last check at HH:MM: <error>." | "Open deployment" |

   - **Empty state (not in the canvas):** keep the card. Show one row with a `CheckCircle` fill
     icon in success, the title "Nothing needs attention" and the detail "Stopped processes are
     not counted." Show no count tag.
3. **Host section** (`id="host"`).
   - Head: "Host" 14px/600 plus "This machine. Sampled every 20 s, kept for <retention>. Hover
     a chart for exact values." (12px `--muted`).
   - Grid `repeat(auto-fit, minmax(280px, 1fr))`, gap 12px, with three cards: CPU (accent),
     RAM (success), Disk (info).
   - Card: `--bg-2`, border, `--r-2`, padding 14px→16px 16px 12px.
     - Row 1: label 12px/600 `--text-dim`. On the right a status tag when the value is ≥ 75:
       "High" (warning soft) or, at ≥ 90, "Critical" (critical soft), each with an 11px
       `WarningCircle` fill. These match the existing `pressure()` thresholds.
     - Row 2: value in mono 24px/600, line-height 32px, `--text`; never colored. Next to it a
       12px `--muted` subline: CPU "average across all cores", RAM "9.8 of 16.0 GB used"
       (from `ramUsed`/`ramTotal`), Disk "421 of 460 GB used" (`diskUsed`/`diskTotal`).
       Format with `formatBytes`.
     - Row 3: "24 h peak <mono value> at HH:MM" (12px `--muted`, value in `--text-dim`).
     - Chart: `TimeSeriesChart`, 120px tall, fixed 0 to 100%, ticks 0/50/100%. Starts 14px→16px
       below row 3.
4. **No process table.** It was in an earlier draft and was dropped on purpose: the sidebar is
   the only process list.

### 3.2 Logs tab (`ProcessLogs.dc.html`)

There is no functional change. The design shows the existing LogStream with the new header and
tabs. Visual details already true in code stay: error rows get the new error tint, and the time
column is 64px. Only the token change affects it.

### 3.3 Metrics tab (`ProcessMetrics.dc.html`, `MetricsPanel.jsx`)

- **Removed:** the **Host** section. In its place, at the end, add an `Info` 14px line:
  "Host RAM and disk live on the Overview." plus a link "Open host metrics" (→ Overview
  `#host`).
- **This process.** Head: "This process" plus "Sampled every 20 s, kept for <retention>. Hover
  a chart for exact values." Keep the existing "History is not stored…" notice and the "Turn on
  monitoring" button when not monitored.
  - Grid `repeat(auto-fit, minmax(380px, 1fr))`, gap 12px, two big cards (padding 14px→16px
    16px 12px):
    - head row: label 12px/600 on the left, "24 h peak <value> at HH:MM" on the right;
    - value: mono 24px/600;
    - legend: only on charts with two or more series, 11px `--muted`, 12px line keys (solid or
      dashed);
    - chart: 160px tall.
  - **CPU** (`id="metric-cpu"`). Series: process CPU (accent, area) and **Host CPU** (`--muted`,
    dashed `4 4`, no area) for comparison. Y range is 0 to a nice ceiling of the max of both
    series (design: 0/25/50%). The tooltip lists both series at the hovered time.
  - **Memory** (`id="metric-mem"`). Series: process memory (success, area). When the process
    has a deployment with `pm2_options.max_memory_restart`, draw a threshold. Parse `300M` /
    `1G` / bytes to bytes with a new helper in `src/services/format.js`. The threshold is a
    1px dashed line in critical at 70% opacity, labeled at its right end above the line, 11px
    `--text-dim`: "PM2 restarts it above 300 MB". It has no legend entry. Y range: nice
    ceiling of max(series, threshold) (design: 0/200/400 MB).
- **Application metrics.** Head unchanged. Grid `repeat(auto-fill, minmax(240px, 1fr))`, gap
  12px.
  - Small card: padding 12px 16px, gap 10px→12px, name 12px/600 on the left, current value in
    mono 14px/600 on the right.
  - Chart: `TimeSeriesChart` in **compact** mode, 56px, info color. No axes, only a baseline.
    The tooltip sits above the plot: value plus time.
- The stat-strip cpu/mem links keep scrolling to `#metric-cpu` / `#metric-mem`.

### 3.4 Manage tab (`ProcessManage.dc.html`, `ManagePanel.jsx`, `monitoring.less`)

- Content max-width 880px, padding 20px, gap 16px.
- Every section becomes a card: `--bg-2`, border, `--r-2`.
  - Card head: padding 16px 16px 12px, title 14px/600, hint 12px `--muted` 4px below.
  - Rows: flex, gap 16px, padding 12px 16px, top border. Text block `flex: 1 1 320px`, label
    13px/600, hint 12px `--muted` 2px below. The control sits on the right.
- Cards, in this order:
  1. **History and alerts.**
     - Row "Store logs and metrics": the "On" accent tag when on. Hint "Logs are kept for
       <logs retention>, metrics for <metrics retention>." Control: "Turn off" `ConfirmButton`
       danger (unchanged question). When off, keep today's benefits list and the "Turn on"
       primary button.
     - Row "Alerts", only when monitored: hint "Notify when a log line of <name> matches the
       alert rules. Rules and reporters are set in Settings, Alerting." Make "Settings,
       Alerting" a link that opens Settings on the Alerting page. Control: the existing toggle.
  2. **Log level**, only when online. Hint unchanged. Row "Current level" with the level tag.
     Control: a segmented group (wrapper padding 2px, `--bg-1`, border, `--r-1`). Buttons are
     26px high, padding 0 10px→12px, 12px/500. Active: `--accent-soft` on `--accent`.
     Inactive: `--text-dim`, with `silent` in `--muted`. Keep `aria-pressed` and the busy
     disable. Keep today's unsupported hint.
  3. **Custom actions** (`Actions.jsx`): rows padding 10px→12px 16px with a top border, the
     action name in mono 12px, an optional parameter input (200px, 26px) and a "Run" `btn--sm`
     on `--bg-1`. The success or failure result shows inside the card below the rows (existing
     `action-result`).
  4. **Remove**, title in critical.
     - "Delete from PM2" now always shows for non-orphans. While the process runs, the button is
       disabled with the title "Stop the process first" and the hint "Stop <name> first. You can
       then keep the cloned files on disk or remove them too." (or the non-deployment variant).
       Once stopped, it is today's `ConfirmButton` with the same choices.
     - The orphan row is unchanged.
- **Removed:** the **Deployment** section. It now lives in the Deploy tab.

### 3.5 Deploy tab, idle (`ProcessDeploy.dc.html`)

A new component, e.g. `DeployPanel.jsx`. Two columns as a flex-wrap row with gap 16px: the main
column `flex: 999 1 520px`, the side column `flex: 1 1 300px`.

- **Deployment card** (main).
  - Head: padding 16px. Title "Deployment" plus the hint "Hawkeye cloned <name> from Git and
    runs it under PM2." On the right:
    - **Edit configuration**: `btn` on `--bg-1` with `PencilSimple` 13px. Opens the deploy
      modal in edit mode (3.8).
    - **Redeploy now**: primary, `ArrowClockwise` 13px. Wrap it in `ConfirmButton` with the
      question "Redeploy <name> from <branch>?" and the choice "Redeploy". `ConfirmButton`
      needs a new `variant: 'primary'` (and an optional icon) for this; document it with
      JSDoc. On confirm it calls `POST /api/deployments/:id/redeploy` **directly**, with no
      form, and the tab switches to the run panel.
  - Below the head, a `<dl>` grid `minmax(120px,160px) 1fr`. Every cell has a top border and
    padding 10px→12px 16px (dd: right padding 16px, left 0). dt is 12px `--muted`. Rows:
    - Repository: mono 12px, `repo_url`.
    - Branch: mono tag on `--bg-3`.
    - Folder on this server: mono `deploy_path` in `--text-dim`.
    - Last deployed: success `CheckCircle` 13px plus a formatted date, then "(2 h ago)" in
      `--muted`. Or "Never" in critical.
    - Local changes: "Asks before discarding them" or "Discards them without asking"
      (`discard_local_changes`).
- **"What a redeploy does" card** (main). Hint "These steps run in order. Steps that are not set
  up are skipped. If one fails, the steps after it do not run and the running process stays as
  it is."
  - Ordered list rows: grid `24px 1fr`, gap 12px, padding 12px 16px, top border.
  - Number: a 24px circle with mono 11px/600 digits. Active steps use `--accent-soft` /
    `--accent`; skipped steps use `--bg-3` / `--muted`, and so does their title.
  - Title 13px/600 plus a 12px `--muted` note. A code block below: padding 6px→8px
    10px→12px, `--bg-0`, border, `--r-1`, mono 12px/18px, `--log-default`, `pre-wrap`.
  - Steps, built from the deployment record:
    1. Pre-setup script: the script, or "Not set, skipped".
    2. Update the code: `git fetch --depth 1 origin <branch>` and
       `git checkout -B <branch> FETCH_HEAD`, note "Untracked files such as .env stay".
    3. Install dependencies: the install command, or skipped for `skip`.
    4. Build: the command, or skipped.
    5. Post-setup script: the script, note "Runs inside the repository", or skipped.
    6. Restart in PM2: the start script, with a note summarizing mode, instances and
       `max_memory_restart`.
- **Auto-deploy card** (side).
  - Head: the title, an "On" accent tag or "Off" neutral tag, and a "Change" link on the right
    (opens edit mode).
  - Text, when on: "Checks <branch> every <n> min and redeploys when it has new commits. Local
    changes are discarded without asking, since nobody is there to confirm." When off: "Deploys
    only when you start it here."
  - `<dl>` rows (12px, value right-aligned mono):
    - Last check (`watch_last_checked_at`, HH:MM or "Not checked yet");
    - Next check (last check plus interval);
    - Last deployed commit (`watch_last_commit`, first 7 characters, row hidden when null).
  - When `watch_last_error` is set, show a warning-soft box (`--r-1`, padding 8px 12px,
    `Warning` 14px): "The last check failed: <mono error>".
- **Environment card** (side): a "Change" link. Text "Applied on every deploy. Values are not
  shown here." Rows: Env file (mono, or "None"), Variables (key chips only, mono on `--bg-3`,
  **never values**). With neither set: "No env file and no variables set."

### 3.6 Deploy run panel (`DeployRunning.dc.html`, tweak `state`)

This replaces the modal's `DeployProgress` view. While a run of this deployment is active, or
until the user dismisses a finished run, the Deploy tab shows the run card above the idle cards.
The canvas shows it alone for focus.

- **Card head:** padding 16px, bottom border. A state icon (18px, `CircleNotch` spinning
  accent, `Warning` fill warning, `WarningCircle` fill critical or `CheckCircle` fill success),
  then a title (14px/600) and a subline (12px `--muted`):
  - running: "Redeploying <name>" / "Step <i> of <n>: <step>. <name> keeps serving the old
    version until the restart."
  - confirm: "Redeploy is waiting for you" / "Nothing has changed yet. <name> keeps running the
    old version."
  - failed before the start step: "Redeploy failed at <Step>" / "The steps after <Step> did
    not run. <name> was not restarted and still runs the previous version."
  - failed at the start step: "Restart in PM2 failed" / "Check the output below."
  - success: "Redeployed" / "<name> restarted at HH:MM with the latest <branch>."
  - For a first deploy, say "Deploying" / "Deployed" / "<name> started at HH:MM".
  - Head actions: failed → "Edit configuration" plus primary "Try again" (calls redeploy).
    Success → "Open logs".
- **Body:** a flex-wrap row.
  - Left, the step list: `flex: 1 1 220px`, padding 12px 8px, right border. Rows: grid
    `16px 1fr`, gap 10px→12px, padding 8px, `--r-1`. Active, waiting and failed rows get a
    `--bg-3` background.
    - Icons: done `CheckCircle` success, running `CircleNotch` accent spinning, waiting
      `Warning` warning, failed `WarningCircle` critical, pending a 10px ring 1.5px in
      `--muted`.
    - Title 13px/600 (`--muted` when pending or skipped). Note 12px `--muted`: the command, or
      "Waiting for you", "Did not run", "Exited with code N".
  - Steps: only the stages that will run, derived from the deployment config (pre-setup only if
    set, install unless `skip`, build only if set, post-setup only if set, clone/update and
    start always). Label `clone` as "Clone the repository" on a first deploy and "Update the
    code" on a redeploy.
  - Mapping progress events (`deploy_progress`: `stage`, `line`, `status`):
    - the current stage is the latest event's stage;
    - stages before it are done;
    - `status: 'confirm'` marks the current stage waiting;
    - stage `error` marks the last real stage seen as failed and every later stage as did not
    run;
    - stage `done` marks all done.
  - Right, `flex: 999 1 420px`, padding 16px, gap 12px:
    - **Confirm callout** (confirm state only, `role="alert"`): padding 16px, warning callout
      fill and line tokens, `--r-2`.
      - Title "The deploy folder has local changes".
      - Text: "Updating to the latest <branch> would overwrite these files. Discard them to
        continue, or cancel the deployment. Untracked files stay either way."
      - A `<pre>` with the porcelain output.
      - Buttons: "Discard changes and continue" (danger) and "Cancel deployment" (default).
      - Hint: "Do not want to be asked again? Set Local changes to Discard without asking in
        the configuration." with "configuration" opening edit mode.
      - This stays a bespoke prompt; CLAUDE.md already lists it as an exception.
    - **Output box:** `--bg-0`, border, `--r-2`.
      - Head: padding 8px 12px, bottom border, "OUTPUT" in 11px uppercase `--muted`, state text
        on the right ("Live", "Paused" or "Finished").
      - Body: padding 10px→12px 12px, mono 12px/20px, min-height 200px, auto-scroll.
      - Line colors: default `--log-default`, git and npm detail lines `--muted` (any line that
        is not a Hawkeye step announcement), confirm lines warning, error lines critical, the
        final "Deployed." success.
- Below the card, 12px `--muted`: "You can switch to another process or tab while this runs.
  The deployment keeps running on the server even if you close the page."
- **After a page reload during a run:** the deployment has `deploying = 1` but the client has
  no events. Show the running head with the subline "Started before this page was loaded, so
  its earlier output is not shown. New output appears here." Steps stay pending until events
  arrive. Do not invent progress.
- **State:** keep progress **per deployment id**, not per modal. Today `deployProgressLines`,
  `deployProgressStage` and `deployProgressStatus` belong to whatever the modal shows, and
  `deployProgressBufferRef` holds the rest. Fold both into one map
  `deploymentId → { lines, stage, status, confirmChanges, finishedAt }`, keeping the bounded
  eviction from `bufferDeployProgress`. `onConfirmDeploy` takes the deployment id instead of
  reading `activeDeploymentId`.

### 3.7 Deployment without a PM2 process (`DeployFailed.dc.html`)

Shown when an offline deployment is selected.

- **Header:**
  - The name, then a status text: "deploy failed" in critical, "deploying" in accent or "not in
    PM2" in `--muted`.
  - A non-interactive repo chip.
  - No Restart or Stop buttons.
  - In place of the stat strip, 12px `--muted`: "No PM2 process. Hawkeye has a deployment for
    <name>, but it never started." For `offline`: "No PM2 process. It was last deployed
    <date>."
- **Tabs:** only **Deploy**.
- **Callout** for `broken` (critical callout tokens, `--r-2`, padding 16px, `role="alert"`,
  `WarningCircle` 18px):
  - Title "The first deployment did not finish".
  - Text: "Nothing runs in PM2 yet. Fix the cause, then deploy again. The output of the failed
    run is not kept after a page reload, so deploying again also shows you the error."
  - Buttons on the right: "Delete deployment" (`ConfirmButton` danger, question "Delete
    <name>?", calls the existing `onDeleteDeployment`), "Edit configuration", and primary
    "Deploy again" (`RocketLaunch`, calls redeploy).
  - For `offline`, use a neutral bordered callout with the title "<name> is not in PM2" and
    the same buttons.
  - For `deploying`, show the run panel (3.6) instead.
- **Below:** the same cards as 3.5. The steps card is titled "What a deploy does" with the hint
  "The first deploy clones the repository. Later redeploys fetch the branch instead." Step 2 is
  "Clone the repository" with `git clone --branch <branch> --depth 1 <repo> <deploy_path>`, and
  step 6 is "Start in PM2".

### 3.8 New deployment and Edit configuration (`NewDeployment.dc.html`, `DeployModal.jsx`)

The modal stays a modal and keeps `useDialogFocus`. The progress view leaves it (3.6).

- **Frame:**
  - Overlay `--scrim`. Dialog max-width 1040px, centered with 40px top margin, `--bg-1`, 1px
    `--border-strong`, `--r-2`, `--shadow-2`.
  - Header: padding 14px→16px 20px, bottom border. Title 14px/600 and subline 12px `--muted`:
    - new: "New deployment" / "Hawkeye clones a Git repository onto this server and runs it
      under PM2.";
    - edit: "Edit <name>" / "Changes apply on the next deploy.".
  - Close icon button on the right.
- **Body:** a flex-wrap row.
  - The form, `flex: 999 1 520px`, padding 20px, section gap 28px→32px.
  - The preview column, `flex: 1 1 320px`, padding 20px, `--bg-0`, left border.
- **Form sections** (`fieldset`). Legend: a 20px numbered circle (sections 1 and 2:
  `--accent-soft`/`--accent`; section 3: `--bg-3`/`--text-dim`) plus 13px/600 text, 16px
  below.
  - **1 "Where the code comes from"**
    - Repository URL\*: hint "HTTPS or SSH. A private repository needs a deploy key on this
      server."
    - A two-column grid `repeat(auto-fit, minmax(200px, 1fr))` with gap 16px:
      - Branch: hint "Fetched again on every redeploy."
      - App name\*: **auto-filled from the repository URL** until the user types in it. Take the
        last path segment, strip `.git`, lowercase, map invalid characters to `-`, and match
        `validateAppName` in `lib/service/deployRunner.js`. Hint: "Taken from the repository
        name. It becomes the PM2 process name and the folder name, and cannot change later."
        In edit mode it is read-only on `--bg-1` in `--muted`, with the existing edit hint.
  - **2 "How to build and start it"**
    - Grid: Install command (the existing select) and Extra install flags (hidden for
      `skip`).
    - Grid: Build command (hint "Leave empty to skip the build step.") and Start script\* (hint
      "Entry point, relative to the repository root.").
  - **3 "Options"**, with the inline note "The defaults work for most apps." (12px `--muted`).
    - A bordered list (`--r-2`). Each option is a `<details>` row: summary 44px high, padding
      0 12px, `CaretRight` 12px rotating 90° when open, title 13px/500, summary text 12px
      `--muted` right-aligned. Body padding 4px 12px 16px 34px→32px.
    - Map today's fieldsets:
      - **Environment**: env file plus the KeyValueList.
      - **Auto-deploy**: unchanged.
      - **Local changes on redeploy**: was "Redeploy".
      - **Setup scripts**: pre- and post-setup moved out of "Install and build".
      - **How PM2 runs it**, **Crash recovery**, **Logging and file watching**: unchanged.
    - Summaries as today. Environment is open by default only when it has values.
- **Inputs:** 32px, padding 0 10px→12px, `--bg-2`, border, `--r-1`, mono 12px for every
  technical field. Focus style: border `--accent-line` plus a 3px `--accent-soft` ring. Labels
  12px/500 `--text-dim` with an `--accent` asterisk; hints 12px `--muted`.
- **Preview column** "What Hawkeye will do" (edit: "What a redeploy will do"), subline
  "Updates as you fill in the form."
  - It re-renders on every keystroke, so it uses the live form state, not the saved record.
  - Steps (20px circles, same styles as 3.5):
    - Clone (`git clone --branch <branch> --depth 1 <repo> <deployBaseDir>/<name>`); in edit
      mode "Update the code" with fetch and checkout;
    - Install, or skipped;
    - Build, or "Skipped, no build command";
    - Start in PM2 (edit: Restart), note "as <name>, fork mode, 1 instance". This note follows
      the PM2 options.
  - Ends with a line on a top border, 12px `--text-dim`:
    - new: "After that, <name> appears in the sidebar and its Deploy tab shows the progress."
    - edit: "Save keeps <name> running as it is. Save and redeploy runs these steps now."
- **Footer:** padding 12px 20px, top border. Left, a 12px `--muted` hint: "The deployment runs
  on the server. You can close this window once it has started." / "Save does not touch the
  running process." Errors replace the hint (`action-result` critical). Right: "Cancel"
  (`btn--quiet`), "Save" (edit only, `btn`) and the primary button ("Deploy" with
  `RocketLaunch`, or "Save and redeploy").
- **After submit:**
  - "Deploy": POST as today. Close the modal, select the new deployment (it is offline until PM2
    has it, so use its `deployment:<id>` key) and show its run panel. When the PM2 process
    appears, move the selection to the process and keep the Deploy tab open.
  - "Save and redeploy": PUT, close the modal, switch to the Deploy tab and fire the redeploy.
  - "Save": PUT, close, reload deployments (as today).

## 4. `TimeSeriesChart` (replaces `Sparkline.jsx`)

A new `src/components/TimeSeriesChart.jsx`. Delete `Sparkline.jsx` and its CSS once
`MetricsPanel` and `Overview` use the new component; `graft callers` shows nothing else. Keep
what is right in Sparkline: measure with `ResizeObserver` so the SVG maps 1:1 to pixels, and
render **step interpolation**. The metrics scheduler skips unchanged samples, so straight
segments would invent values. The canvas draws straight segments only because its sample data
is dense.

**Props:**

```js
/**
 * @param {{
 *   series: { name: string, color: string, samples: { t: number, v: number }[], dashed?: boolean, area?: boolean }[],
 *   height: number,                  // 120 host, 160 process, 56 compact
 *   max?: number,                    // fixed top (100 for host %); otherwise niceCeil of the data
 *   ticks?: number[],                // y ticks; omitted in compact mode
 *   formatValue: (v: number) => string,
 *   formatTick?: (v: number) => string,
 *   threshold?: { value: number, label: string },
 *   compact?: boolean,               // no axes, tooltip above the plot
 *   label: string,                   // accessible name, e.g. 'Host CPU over the last 24 hours'
 * }} props
 */
```

**Geometry and marks** (spec: the plot block in `Main.dc.html`):

- The Y range starts at 0, with 4px top and bottom padding inside the plot.
- Layout:
  - Non-compact: grid `1fr 32px` (host) or `1fr 44px` (process charts, wider labels), column
    gap 8px, row gap 6px→8px. The plot spans cell 1; Y labels sit in cell 2, left-aligned,
    10px mono `--muted`, vertically centered on their tick. X labels sit in a 14px row under
    the plot.
  - Compact: a plain plot with no axes.
- Gridlines: 1px solid. The baseline uses the 0.1 hairline token, the other ticks the 0.05
  token. Never dashed.
- Lines: 2px, round join and cap, non-scaling stroke. Dashed series use `4 4`.
- Area: series color at 10% opacity, flat, no gradient. Off for dashed comparison series.
- End dot: a series-colored 8px circle with a 2px `--bg-2` ring (`box-shadow`) at the last
  sample. Hidden while hovering.
- X ticks: full hours in the sample window at a spacing that yields 3 to 5 ticks (1, 3, 6, 12 or
  24 h), HH:MM, centered. Skip ticks closer than 90 minutes to "now". The last label is "now",
  right-aligned at 100%.

**Hover and focus:**

- `onPointerMove` snaps to the nearest sample time of the first series. For each other series,
  use its sample at or before that time (step semantics).
- Crosshair: a 1px vertical line in the crosshair token at the hovered X, full plot height.
- Hover dots: 8px with the 2px ring, one per series, at that X.
- Tooltip, one for all series (`role="status"`):
  - Box: `--bg-0`, 1px `--border-strong`, `--r-1`, padding 6px 10px→12px, the tooltip shadow
    token, no wrapping, `pointer-events: none`.
  - One row per series: a 10px line key (dashed if the series is), the value in mono 12px/600
    `--text`, then the series name in 11px `--muted`. Value first.
  - Last row: the timestamp in mono 11px `--muted`, formatted "23 Oct, 09:50".
  - Placement, non-compact: top of the plot, 12px to the right of the crosshair, or 12px to
    its left once past 62% of the width. Compact: 6px→8px above the plot, centered on the
    crosshair, pinned to the left edge below 30% and the right edge above 70%.
- Keyboard: the plot is focusable (`tabIndex={0}`, `role="img"`, `aria-label` = label plus the
  current value plus "Use the arrow keys to read values."). Focus selects the last sample.
  Left and right arrows step one sample. Blur and pointer leave clear the hover. The focus ring
  is 2px `--accent-line` at a 4px offset.
- Threshold: a dashed line plus a label (see 3.3). It is included in the Y max.
- Fewer than 2 samples: keep today's "Not enough history yet" placeholder at the chart height.

**24 h peak:** the cards compute the maximum of the first series and its time. Put that in a
small helper next to the chart so Overview and Metrics share it.

## 5. Backend

- `GET /api/auth/session`: add `deployBaseDir: config.DEPLOY_BASE_DIR` to `config` (already an
  absolute path, see `lib/config.js`). The form preview needs it.
- Add a test asserting the field in the session tests (`test/`, Mocha).
- No other backend change. Deployment history and replaying progress after a reload are **out
  of scope**; the UI must not imply they exist.

## 6. Removed or moved (checklist)

- [ ] Welcome card ("No process selected") and its CSS.
- [ ] Header **Redeploy** button.
- [ ] Manage **Deployment** section.
- [ ] Sidebar **Not deployed** group and the buttons on its rows.
- [ ] Metrics **Host** section.
- [ ] `DeployProgress` view inside `DeployModal.jsx`, `StagePillBar` and its CSS (`deploy-stages`).
- [ ] `Sparkline.jsx` and `sparkline-*` CSS.
- [ ] Icon exports that are no longer used.

## 7. Docs to update

- `README.md`:
  - around line 54: the host readout now opens the Overview, not the Metrics tab;
  - line 82: monitoring stays in Manage;
  - lines 534 to 540: "Redeploying and editing" needs a rewrite: Deploy tab, Redeploy now
    without a form, Edit configuration, run panel, deployments without a PM2 process selectable
    in the sidebar.
  - The screenshots `docs/screen1.png` and `docs/screen2.png` will be outdated. Tell the user;
    do not fake new ones.
- `CLAUDE.md`, "Frontend structure":
  - add `Overview.jsx`, `DeployPanel.jsx` (or your names) and `TimeSeriesChart.jsx`;
  - drop `HostMetrics.jsx` if folded in;
  - tabs are now Logs, Metrics, Deploy, Manage;
  - DeployModal is now "deploy form only".
  - Update the architecture paragraph that mentions the deploy modal's progress view.

## 8. Verification

- `npm run lint`, `npm run format:check` and `npm test` all pass.
- Run the two-process dev setup from CLAUDE.md (backend 3030, `npm run dev`, open
  `http://localhost:3042`). Compare every screen side by side with its artboard at 1440px
  width: spacing, sizes, colors and copy.
- Check states that the canvas only names:
  - attention empty state;
  - an offline deployment in each status (`broken`, `offline`, `deploying`);
  - a run in each state, including the reload-during-run case;
  - the Metrics charts without monitoring (notice plus live-only data);
  - a process without `max_memory_restart` (no threshold).
- Hover and keyboard on every chart: crosshair snaps, the tooltip flips at the edges, and arrow
  keys step through samples.
- Narrow viewport (≤ 720px): the existing drawer still works, cards stack, and the deploy modal
  columns stack.
- Report anything you could not verify, with the reason.

## 9. Out of scope

Settings overlay, login page, footer content, log stream behavior, any new backend storage.
