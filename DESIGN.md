# DESIGN.md — Design source of truth

This file defines how ProjectManager looks and behaves. If a component disagrees with this file, either
fix the component or update this file in the same commit — never let design decisions live only in code
or chat history.

## 1. Principles

1. **Calm developer tool.** Dense but quiet, in the spirit of GitHub and Linear. Content (numbers, charts,
   cards) carries the colour. Chrome stays neutral.
2. **Show, don't explain.** Lead with numbers and charts. Explanatory text is short and secondary.
3. **Local-first and honest.** Every number comes from the user's disk or git. When a value is an
   estimate (complexity) or capped (scan limits), say so in a hint.
4. **Never surprising with user files.** The UI never modifies or deletes files on disk. "Remove" means
   "stop tracking" and the UI wording says so.
5. **Delight in small doses.** Rare UI animated components (§8) add motion at key moments (counters,
   the heatmap, delete confirmation, tabs). Don't add motion anywhere else.

## 2. Layout

Layout follows the sister project KDP Publishing Pipeline (`../KdpPublishingPipeline`, Svelte):
shell owns the viewport, panes scroll independently, bars hold one row via intrinsic
sizing (never a viewport breakpoint for in-panel bars), and refreshing never blanks
a populated pane.

- **App shell:** `#root` is `100dvh` + `overflow: hidden` (KDP `App.svelte`). Below the 48px
  top bar, `.app-shell` is `flex: 1; min-height: 0; overflow: hidden`. `.app-main`
  scrolls (`overflow-y: auto`); the sidebar scrolls its own list. There is exactly one
  page scrollbar. Thin 6px scrollbars everywhere.
- **Sidebar (256px, KDP width):** filter + sort/add row on top with fixed slots (filter is
  the only elastic part, so the row never lurches when badges appear), then two-line rows:
  name + state badge, then one glance line (lines · top language · relative last commit).
  The full path lives in the `title` tooltip, not a third line. Footer holds a portfolio
  totals card (lines / 30-day commits / in flight — the KDP "Active Focus" analogue) so
  totals never require a trip home. Polls every 2s while any scan runs, otherwise every 10s,
  and never replaces populated rows with skeletons (KDP populated-pane rule).
- **Sorter (KDP Library sorter):** modes Name / Recent commit / Lines of code, each with a
  natural direction (A–Z, newest first, most code first). Re-selecting the active mode flips
  its direction; switching modes restarts from the new mode's natural direction. The trigger
  and menu labels always name the active direction, comparators are written once and
  negated for reverse, and the choice persists in localStorage. Outside click / Esc closes.
- **Page headers are intrinsic (KDP Opportunities back-bar rule):** the title block is the
  only elastic part and truncates; `.actions` is `flex: none`, so the bar degrades by
  truncating text rather than stacking controls.
- **Page container:** `.page`, max-width 1280px, centred, 16px vertical padding,
  `--gutter` horizontal, 14px section gaps. Stats tiles start at 132px columns.
- **Density budget:** panel padding 14–16px, card gaps ≤ 12px, footer ≤ 16px. New chrome
  must earn vertical pixels: prefer a second line of glance data over a new section.
- **Narrow screens:** the sidebar becomes one horizontal strip (controls in a single row,
  projects as sideways-scrolling chips, footer hidden) — never a tall stacked panel that
  eats the first screenful.
- **The all-projects overview (`/`) is pinned prominent:** first item in the sidebar
  ("All projects" with an accent icon when active, above the filter) and a topbar nav
  link. It is never buried under the project list.

## 2b. Dashboard (home)

The home page is the master dashboard for all tracked folders, top to bottom:

1. Portfolio summary tiles (projects, lines, disk, 30-day commits, planned, in flight).
2. **Needs attention** (only when non-empty): missing folders, failed scans, repos with no
   commits for 90+ days.
3. Portfolio rollups: languages summed across projects (same slots/Other rule as §5) and
   merged commits-per-month.
4. **Rankings**: one sortable table (Project / Lines / Commits 30d / Last commit / Planned /
   In flight). Column clicks follow the sorter rule — a new column starts from its natural
   direction, clicking the active column reverses it — with `aria-sort` and a visible
   arrow. Lines cells carry a thin size bar.
5. Project cards grid (visual entry points, unchanged).

- **Page header:** title + mono path subtitle on the left, actions on the right. Wraps on narrow screens.
- **Grids:** `.stats` (auto-fill tiles, min 150px), `.grid-2` (two columns → one under 900px),
  `.grid-cards` (auto-fill project cards, min 340px → one column under 600px).
- **Panels:** `.panel` is the standard surface: 12px radius, 1px border, 16–18px padding. Each one has a
  `.panel-header` (h2 + muted meta on the right).
- **Board:** 5 equal columns (min 220px). Scrolls horizontally on small screens rather than stacking.

## 3. Typography

- System font stacks only (no web fonts; the app must work offline):
  `--font-sans` for UI, `--font-mono` for paths, hashes, card keys and file names.
- Base 14px / 1.5. h1 22px/650, h2 15px/600, h3 13px/600. Stat values are 22px/650.
- All numbers that line up use `font-variant-numeric: tabular-nums` (`.num`, tables, stats).
- Text colours: `--text` (primary), `--text-2` (secondary), `--text-3` (hints/meta). Data text never
  takes a series colour. Values and labels stay in text tokens.

## 4. Colour

All colours are CSS custom properties on `:root` in `client/src/styles.css`. Dark values are defined under
`@media (prefers-color-scheme: dark)`, guarded by `:root:not([data-theme='light'])` so that a future
theme toggle can override them. Components reference roles, never raw hex. (Rare UI components contain
some of their own fixed colours, which is accepted.)

| Role                               | Use                                              |
| ---------------------------------- | ------------------------------------------------ |
| `--bg`, `--surface`, `--surface-2` | page, panels/cards, insets/tracks/columns        |
| `--border`, `--border-strong`      | dividers, input borders, hover borders           |
| `--accent` (+ `-hover`, `-soft`)   | primary buttons, focus, active tab, drop targets |
| `--danger` (+ `-soft`)             | errors, "folder missing"                         |
| `--series-1..7`, `--series-other`  | categorical data (languages), in fixed order     |
| `--heat-0..4`                      | sequential blue ramp for commit intensity        |

Tailwind's shadcn names are mapped onto these tokens (`foreground → --text`, `background → --surface`,
`card → --surface-2`) in the `@theme inline` block, so Rare UI components follow the theme.

## 5. Data visualisation

The palettes come from a validated, colour-blind-safe reference set (categorical slots tested for
adjacent-pair CVD separation in both modes).

- **Categorical (languages):** the largest language gets slot 1, then slot 2, and so on, up to 7 slots.
  Anything beyond that folds into a neutral grey **Other**. Never generate extra hues. A language's colour
  is consistent within a project page (bar, legend and table swatch all match).
- **Sequential (commit heatmap):** a single blue hue from light to dark. Level 0 is the grid's neutral
  tint. Levels 1–4 are quartiles of the busiest day in the window.
- **Single-series bars** (folder sizes, contributors, commits per month) use `--series-1` and need no legend.
- **Marks:** thin bars with 4px rounded data ends, anchored to the baseline. The language bar uses 2px
  surface gaps between segments.
- **Hover:** every chart has a tooltip (`useTooltip()` in `components/charts.tsx`, or the built-in one in
  the Rare UI heatmap). Tooltips are dark-on-light (inverted) and never block the pointer.
- **Accessibility:** charts have an `aria-label` summary. The monthly chart includes a screen-reader
  table. The language bar always comes with a legend and the full table.
- **Never:** dual axes, rainbow scales, or a number printed on every bar.

## 6. Components and interaction

- **Buttons:** `.btn` (secondary), `.btn-primary` (one per view, the main action), `.btn-ghost`,
  `.btn-danger`, plus `.btn-sm` and `.btn-icon` sizes. Height is 32px (26px for small).
- **Inputs:** `.input`, `.select`, `.textarea`, each wrapped in `.field` with a visible `<label>`.
- **Dialogs:** native `<dialog>` with `showModal()`, which gives focus trapping, Esc to close and a
  backdrop. Layout is `.dialog-body` + `.dialog-footer` (destructive action on the left, Cancel and
  primary action on the right).
- **Destructive actions:** use Rare UI `DeleteButton` (confirm in place, no modal, Esc cancels).
  Never use `window.confirm`.
- **Tabs (project page):** Rare UI `GooeyNav`, controlled and synced to `?tab=` in the URL.
- **Kanban:**
  - Native HTML5 drag-and-drop. A drop indicator line appears above the target card, and the column
    highlights when dropping at its end.
  - **Keyboard alternative:** open a card (Enter/click) and change its **Column** select. Every
    drag-and-drop action has a non-drag equivalent.
  - New cards go to the **top** of a column. Quick-add stays open for rapid entry; Esc closes it.
  - Card keys (`PM-12`) are always visible in mono so they can be typed into commit messages.
- **Project title:** click to rename inline. Enter saves, Esc cancels, blur saves.

## 7. States

| State           | Pattern                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| Loading (first) | `.skeleton` blocks shaped like the content (pulse animation)                                 |
| Scanning        | spinner + "Scanning…" badge or panel. The page polls every second and keeps old data visible |
| Empty           | `.empty` panel: heading, one sentence, primary action                                        |
| Error           | `.error-banner` near the top of the affected area. Field errors go inside the dialog         |
| Success / info  | `.notice` (e.g. "Moved by commits: PM-3 → Done" with a "View board" action)                  |
| Folder missing  | danger badge on the card and a banner on the project page. The last scan stays visible       |

## 8. Motion and Rare UI

[Rare UI](https://rareui.com) components are installed via the shadcn CLI into `client/src/components/ui/`
and are **owned code**: adapt them freely, and keep a header comment saying what changed.

| Component         | Where                       | Adaptation                                    |
| ----------------- | --------------------------- | --------------------------------------------- |
| `GitHubActivity`  | Commit activity heatmap     | `unit` prop added, fed local data, no network |
| `AnimatedCounter` | All stat tiles (`StatTile`) | none                                          |
| `DeleteButton`    | Remove project, delete card | none                                          |
| `GooeyNav`        | Overview / Board tabs       | Next.js imports removed                       |

Other rules:

- **License:** MIT + Commons Clause + **attribution**. The footer link to rareui.com and the README
  credit must stay.
- All Rare UI components honour `prefers-reduced-motion`. Our own CSS animations (spinner, skeleton) are
  turned off under it too.
- Add motion only through Rare UI components or tiny CSS transitions (≤150ms on colour/border).
- To add one: `npx shadcn@latest add swamimalode07/rare-ui/<name>`, then check the diff. The CLI may add
  stray dependencies (it once added an unrelated `cn` package), and some components import `next/*`.

## 9. Accessibility

- Visible `:focus-visible` outline (2px `--focus`) on everything interactive.
- Every input has a label. Icon-only buttons have an `aria-label`.
- Colour is never the only signal: badges carry text, and charts have legends, tables and labels.
- Status changes (auto-moved cards, delete) are announced through `role="status"` regions.
- Contrast: body text uses `--text`/`--text-2` on surfaces (≥ 4.5:1). `--text-3` is for non-essential hints.

## 10. Responsive behaviour

- Desktop-first, usable down to 360px wide: grids collapse, tables scroll horizontally inside
  `.table-wrap`, and the board scrolls horizontally.
- The heatmap (Rare UI) fits as many weeks as the panel width allows and drops the oldest weeks first.

## 11. Platform notes

- Runs in a browser against a local server on 127.0.0.1. There's no native folder picker: the
  "Add project" dialog browses folders through the API (drive letters on Windows).
- The dialog tracks one folder or many at once: tick checkboxes (or "＋ List" the current path)
  to queue folders, then "Track N folders" calls `POST /api/projects/batch` (max 50, per-folder
  skips reported, never failing the whole batch).
- Folders already tracked show a `✓ tracked` badge with a disabled checkbox; the open folder
  shows an "Already tracking as X" notice that disables single-track actions.
- Paths are shown exactly as the OS reports them (backslashes on Windows) in mono.

## 12. Agent CLI sessions and runs

Persistent, reboot-proof processes for driving AI coding CLIs, modelled on
[Quil](https://github.com/artyomsv/quil) (typed panes, PATH detection, per-type resume,
reboot persistence) and held to [pstack](https://github.com/backnotprop/pstack) principles
(boundary validation, idempotent operations, prove-it-works verification).

- **Sessions** are interactive terminals (project page → Agents tab). They survive GUI
  navigation (server-side processes) and — when supervised and still wanted — crashes,
  server restarts and machine reboots, via `desiredState` + `supervise` + stored resume
  argv (`claude --continue`; shells/custom commands respawn). stdin typed while down waits
  in a durable queue and flushes on spawn.
- **Runs** are one-shot card dispatches (`Task PM-12: …` prompt by default). Dispatch moves
  backlog/todo cards to In progress; a finished run awaits **validation**: Accept moves the
  card to Review (or Done), Reject sends it back to To do. Kanban cards carry Quil-style
  attention badges (▶ running, ✓ awaiting validation, ✗ failed).
- **Providers** (Claude Code, Codex, OpenCode, Gemini, shell, custom) are PATH-probed with
  install links when missing; dispatches use argv arrays, never a shell. xterm.js renders
  terminal output and is code-split so it loads only with a terminal.
- **Trust model:** same-machine only (existing Host allowlist + JSON-write guard). Sessions
  run as your user with your environment; logs live under `data/agent-logs/` (gitignored).
  Caps: 8 sessions/project, 3 concurrent runs/project, 8MB logs, 20min default run timeout.
