# DESIGN.md — Design source of truth

This file defines how ProjectManager looks and behaves. If a component disagrees with this file, either
fix the component or update this file in the same commit — never let design decisions live only in code
or chat history.

## 1. Principles

Agents status filters retain their selected fill during Shift-click and phone long-press selection.
Pointer interactions do not add a keyboard-focus outline; keyboard navigation retains visible focus.

Session usage-limit account switching uses the shared styled Dropdown, with keyboard navigation,
viewport-bounded menus and a 44px mobile trigger, matching other app selectors.

PM-242: desktop agent rows align the card tag, state and action buttons with the session title;
secondary facts sit below. Action groups size to their visible controls without a reserved
minimum width, including ended sessions. Mobile retains its compact two-row arrangement.
Terminal header session names use their natural width, truncating only under actual space
pressure. Desktop project/card metadata gives way first; mobile metadata can wrap beneath the
name. Rename and terminal controls remain available, with full names exposed in tooltips.

Agents list rows offer Continue for running AI CLIs in every status filter except Ended, immediately
before the Show in pane icon, submitting a message without restarting. Ended sessions never offer it.
Continue shows pending/sent/queued feedback and prevents duplicate in-flight sends. Show in pane
uses a pane icon with an accessible name and tooltip. On phones Continue is icon-only and row
actions retain 44px touch targets with compact gaps; desktop keeps the Continue label.
The docked CLI header offers icon-only Continue between image and restart actions for supported
live sessions in every status filter except Ended, matching the list-row rule.
Mobile keeps header Continue inside the compact session actions menu.

Settings > Agent CLIs keeps saved accounts inside each Codex/Claude entry's Accounts drawer.
Codex is the account-switcher UI standard for Codex, Claude and Antigravity: shared account-row
classes, toolbar icons, default identity/email, usage meters, active badges, nickname/remove actions,
and optional drag-reorder mode. Provider-specific authentication and refresh capabilities remain
explicit; Claude refresh rereads attributed snapshots. Antigravity detects the current default login
without silently creating a saved profile.
Saved accounts offer a Reorder mode with touch/pointer drag handles and keyboard Up/Down support;
order persists per provider in this
browser, with Default pinned first. Codex accounts offer individual usage refresh, resolving the
active saved copy to the default login's credential source. Refresh never switches credentials.
Account drawer selection and Agents filter expansion persist across navigation and reloads in
this browser. Reusable view preferences validate stored values and tolerate blocked/full storage.
Antigravity account management is built into ProjectManager on Windows: save the current CLI login,
import credentials, refresh usage and confirm switching for new launches. It writes Windows Credential
Manager and the CLI file mirror, stores encrypted profile snapshots and preserves the previous login.
No agy-auth installation is required. Existing sessions retain their login until restarted.
Codex quota uses identity-verified account-service readings; shared conversation history is never
a quota source. Switching discards in-flight readings started against earlier credentials.
Account usage revalidates at most once per minute while visible and after a known reset passes.
Automatic switching requires fresh verified 100% usage on the current account and verified
positive quota across every destination window. Unknown, failed, stale or reset-due readings
cannot authorize rotation. Rank eligible destinations by the lowest remaining window percentage,
highest first; manual switching remains available regardless of quota.
Refresh failures retain the previous observation time and show unavailable/stale status. Reset
countdowns tick each second from wall time; reaching zero requests fresh evidence rather than
assuming quota has returned. Refresh-all shares the same action/race guard as account switching.
Transient action menus, dropdowns and confirmation dialogs start closed.
Usage status and meters sit in a separate block with an 8px gap below account details and
6px between status and meters. The open drawer revalidates usage each minute; server-side
freshness limits account reads, and polling pauses in hidden tabs and stops on unmount.
Codex offers automatic quota rotation; Claude switching is manual. Account names that equal
the email appear once, with saved time and an Add nickname action.
Codex usage refresh reports fresh, expired, unavailable or unsupported results explicitly;
missing usage never appears as zero. Claude usage is shown as unsupported.
Orchestrator chat open/full-screen state persists per orchestrator in this browser.
One-time chat checks work directly in the chat, with a scoped current-task indicator and a
Needs attention check for dashboard alerts. Board automation retains its configured policy.
Ended, unsupervised card sessions offer Dispose session with a named confirmation; disposal
removes the session and recorded output while retaining its board card.
Batch CLI choices inspects the selected attention sessions, groups detected choices and
reports delivered, queued and failed input. Only failed recipients remain selected for retry.
Continue remaining targets only checked live AI CLIs with no detected prompt, rechecking screens
before sending and refusing any newly appeared prompt. Detected choice groups never receive it.

Orchestrators speak plainly: each one is "an orchestrator" (never "master") and every card reads
top to bottom as what it looks after (one sentence), Ask this orchestrator (chat and one-time
checks), Needs you (issues with Fix / Dismiss, Fix all, on-demand pending list), Board (counts,
Preview plan) and Working now. Results remain visible with task/run links and queue explanations.
Actions preserve paused/Observe configuration and existing quota, capacity and review policy.
Plan preview shows aggregate readiness counts with 100-task pages and explicit Previous/Next
controls. Each page is a fresh inspection; it never starts work.
Desktop Agents toolbar does not repeat the primary Orchestrators navigation link.

Orchestrator strategy is explicit: Observe reports proposals; Autonomous board work dispatches
within existing limits and retains review. Preview plan works while paused, shows snapshot
time and reasons, and never dispatches. Manual attention actions are distinct from strategy.

Route pages load on demand. Navigation and the project sidebar remain available while
the selected page loads, with a short accessible Loading page status in the content area.

Mobile terminal keys sit in one horizontal scrolling row above the software keyboard.
Use 44px pill targets, with Hide keyboard pinned at the right. F1–F12 and standard
shortcuts are directly scrollable; F1–F12 reveals function keys in the same row.
The strip is a body-level overlay aligned to the visual viewport above the keyboard.

Filtered Agents Actions opens below its trigger on desktop (above if space requires),
and as a bottom sheet on mobile. Show in panes is the first item inside Actions.
Batch message uses a modal composer with recipient
count/names, a Continue preset, explicit Send, progress and partial delivery results.
Recipients are frozen when composing; successful recipients are excluded from retries.
While sending, show completed/total, current recipient and stage, sent/failed counts,
and a progress bar. Delivery indicates terminal input submission, not an agent reply.
On phones the composer opens on its heading, with a 16px message field; typing starts
when the user taps it. Expanded mobile filters appear beneath the unchanged toolbar row.
Mobile Filters uses a funnel icon and active-count badge with an accessible label.
The filter toggle is highlighted while expanded and returns to its normal style when collapsed.
The Agents Actions trigger uses the same selected styling as Panes/List while its menu is open.
Mobile workspace and session action toggles share that highlight while expanded.
Searchable dropdowns on phones focus an option on opening; search takes focus only when chosen,
so opening the project filter does not summon the software keyboard.
Expanded filters use two compact columns, with Kind beside Search and Clear filters
aligned at the right. Inputs retain 44px touch targets and 16px search text.
Mobile pane actions keep Auto-continue and action icons together on one row.
CLI Add images opens a multi-select photo picker on desktop and mobile. Selected photos
are added in order; failed photos show their filename while remaining photos continue.
LAN Scan pairing QR opens the photo/camera picker, reads locally, then shows the detected
computer and an explicit Open sign-in page action. No photo is sent to a server.

Orchestrators have a separate `/orchestrators` page, reached from desktop navigation or
mobile Agents tools. Configuration uses project/provider multi-selects, compact worker
and quota fields, and explicit Start/Pause controls. New orchestrators save paused. Activity
keeps waiting, started-work, review and error outcomes visible. Orchestrators, their sections
and Activity collapse with a chevron (remembered per browser).
Optional Dashboard follow-up creates scoped, deduplicated board tasks for attention
signals and pending Git work. Missing-folder tasks remain in review; projects with active
workers defer follow-up. Existing capacity and quota rules govern automatic dispatch.

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
- **No document scroll, ever:** `html, body` are `overflow: hidden`. Even 1px of document
  overflow paints a second bar next to `.app-main`'s, so the rule is structural, not hoping
  content fits. Dialogs are top-layer and unaffected.
- **Topbar:** brand, then primary nav (All projects, Board, Agents), then a right-side utility group
  (`margin-left: auto`) with the theme control followed by Settings. Icon + label pills;
  at phone width (≤ 768px) the nav and Settings move to the bottom tab bar (§10) and the top bar
  keeps only the brand and theme menu.
- **Sidebar (256px, KDP width):** filter + sort/add row on top with fixed slots (filter is
  the only elastic part, so the row never lurches when badges appear), then two-line rows:
  name + state badge, then one glance line (lines · top language · relative last commit).
  The full path lives in the `title` tooltip, not a third line. Footer holds a portfolio
  totals card (lines / 30-day commits / active tasks — the KDP "Active Focus" analogue) so
  totals never require a trip home (plus the Plan usage card above it, PM-41). The project
  count sits in the All projects link's subtitle ("Portfolio · 23 projects", "11 of 23 shown"
  while filtering), not in a footer row of its own (PM-43). Polls every 2s while any scan runs, otherwise every 10s,
  and never replaces populated rows with skeletons (KDP populated-pane rule).
  A project whose web app is running (Preview's detection: a port answering with HTML, started
  from that project's folder) gets a 13px globe in `--good` beside its name, labelled "App
  running: localhost:3000". Icon only and only when something runs, so idle rows and the 150px
  tablet chips lose no width; the row stays one link (the globe is not a nested control). Polled
  every 15s, paused while the tab is hidden.
- **Sorter (KDP Library sorter):** modes Name / Recent commit / Lines of code, each with a
  natural direction (A–Z, newest first, most code first). Re-selecting the active mode flips
  its direction; switching modes restarts from the new mode's natural direction. The trigger
  and menu labels always name the active direction, comparators are written once and
  negated for reverse, and the choice persists in localStorage. Outside click / Esc closes.
  **Custom order** (first option, no direction, ✓ instead of an arrow) shows a grip handle on
  each row: drag it, or focus it and press ↑ / ↓ (the keyboard alternative). The full ordered id
  list is saved server-side (`/api/preferences/project-order`); reordering a filtered list
  refills only the visible projects' slots, so hidden ones keep their places; new projects
  follow the saved order A–Z.
- **Page headers are intrinsic (KDP Opportunities back-bar rule):** the title block is the
  only elastic part and truncates; `.actions` is `flex: none`, so the bar degrades by
  truncating text rather than stacking controls.
- **Page container:** `.page`, max-width 1280px, centred, 16px vertical padding,
  `--gutter` horizontal, 14px section gaps. Stats tiles start at 132px columns.
- **Density budget:** panel padding 14–16px, card gaps ≤ 12px, footer ≤ 16px. New chrome
  must earn vertical pixels: prefer a second line of glance data over a new section.
- **Tablet widths (769–900px):** the shell stacks and the sidebar becomes one horizontal strip
  above the page (controls in a single row, projects as sideways-scrolling chips, footer hidden) —
  never a tall stacked panel that eats the first screenful. Phones get the layout in §10.
- **Sticky chrome:** the dashboard/project headers (+ tabs) live in `.sticky-head`
  (`position: sticky`, opaque page background, one rule line). Titles, actions and tabs stay
  visible while tab content scrolls; banners and notices scroll away. Stuck bars keep 8px
  breathing room above (`.page` top padding compensates, so resting pages are unchanged) —
  sticky content never touches the viewport edge. When the Board/List view switch closes the
  head (global Board), its rule is the head's bottom line: no second border below it.
- **Sticky board column headers (PM-56, Notion-style):** on both boards each column header
  (`.col-stick`) scrolls with its column until it meets the page's sticky chrome, then holds
  there while cards slide underneath. `useStuckTop` (`client/src/stuckTop.ts`) measures the part
  of the page head that actually sticks (the whole `.sticky-head`, or only the tab bar on phone
  project pages) into `--stuck-top`. Columns stretch to the tallest so the headers hold as one
  row; a scroll-state container query adds a rule line and soft shadow only while stuck
  (browsers without it still stick, just without the shadow). Boards never scroll sideways: an
  overflow box would trap the sticky headers.
- **The all-projects overview (`/`) is pinned prominent:** first item in the sidebar
  ("All projects" with an accent icon when active, above the filter) and a topbar nav
  link. It is never buried under the project list.
- **Last page:** opening the app at `/` returns to the last in-app page, including its
  project tab, board filter, or workspace session. Choosing All projects during a visit
  stays there. The choice is per browser (`localStorage`). Paths outside this app are ignored.

## 2b. Dashboard (home)

The home page is the master dashboard for all tracked folders, top to bottom:

1. Portfolio summary tiles (projects, lines, disk, 30-day commits, planned tasks, being worked on).
2. **Needs attention** (only when non-empty): missing folders, failed scans, repos with no
   commits for 90+ days.
3. Portfolio rollups: languages summed across projects (same slots/Other rule as §5) and
   merged commits-per-month.
4. **Rankings**: one sortable table (Project / Lines / Commits 30d / Last commit / Planned /
   Active tasks). Column clicks follow the sorter rule — a new column starts from its natural
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

All colours are CSS custom properties on `:root` in `client/src/styles.css`. Dark values live in one block,
`:root[data-theme='dark']`, with no media query.

- `<html data-theme>` is always `light` or `dark`. An inline script in `index.html` sets it
  before first paint, so the page never flashes the wrong theme.
- `client/src/theme.ts` keeps it in sync with the top-bar switch (Match system / Light / Dark,
  saved per browser). "Match system" follows the OS setting live.
- Tailwind's `dark:` variant (used by Rare UI components) is bound to the same attribute
  (`@custom-variant dark`).

Components reference roles, never raw hex. (Rare UI components contain some of their own fixed
colours, which is accepted.)

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
- **Commits by project** (dashboard, `CommitsByProject.tsx`): stacked columns per month or week.
  - The top 6 projects get slots 1–6, ranked by **12-month** commits whatever range is shown, so a
    project keeps its colour when you switch ranges. The rest fold into grey "Other (n)".
  - The biggest project sits on the baseline. Segments have 2px surface gaps and the stack has a
    rounded top.
  - The legend is a ranked list (total and share) that emphasises one project on hover or focus.
  - The column tooltip shows the breakdown, and there's a Table toggle plus a screen-reader table.
  - The range choice is remembered per viewer (localStorage).
- **Marks:** thin bars with 4px rounded data ends, anchored to the baseline. The language bar uses 2px
  surface gaps between segments.
- **Hover:** every chart has a tooltip (`useTooltip()` in `components/charts.tsx`, or the built-in one in
  the Rare UI heatmap). Tooltips are dark-on-light (inverted) and never block the pointer.
- **Visually hidden tables** must be wrapped in a `<div class="sr-only">`: tables ignore
  `width: 1px`, so `<table class="sr-only">` stretches the page.
- **Accessibility:** charts have an `aria-label` summary. The monthly chart includes a screen-reader
  table. The language bar always comes with a legend and the full table.
- **Never:** dual axes, rainbow scales, or a number printed on every bar.

## 6. Components and interaction

- **Buttons:** `.btn` (secondary), `.btn-primary` (one per view, the main action), `.btn-ghost`,
  `.btn-danger`, plus `.btn-sm` and `.btn-icon` sizes. Height is 32px (26px for small).
- **Inputs:** `.input` (32px, same height as `.btn`) and `.textarea`, each wrapped in `.field` with a
  visible `<label>`. They share the dropdown trigger's border, hover and accent focus ring.
- **Input + button rows (Files filter, Preview address bar, any toolbar with a text box):** the
  buttons beside a `.input` are full `.btn` (32px), never `.btn-sm` (26px), so the row is one
  height and the text lines up; `align-items: center`, input `flex: 1; width: auto; min-width: 0`
  and buttons `flex: none`. Placeholders are short enough not to clip in a 240px panel
  ("Filter files…"). The address input is 16px text so iPhone doesn't zoom on focus; on touch the
  shared rules raise both to 40px together. A `type="search"` input keeps the `.input` box (native
  search styling is turned off).
- **Owner Pages (`scripts/owner-pages.mjs`, PM-258):** the pages the owner reads, built from the same tokens as the app (`--bg`, `--surface`, `--accent`, `--danger`, `--good`, radii and the system font stack, copied from `client/src/styles.css`, so keep the two in step) in both themes through one shell: a sticky top bar with the page links and a Theme button (the choice is kept in this browser and set before first paint), one centred column of at most 920px, cards on `--surface` with a 1px `--border`. The Owner desk shows four summary tiles (Pending, Blocked, Completed, Blocking the agent, the last in `--danger` when above zero), filters for status, priority, category and text, and one card per task: blocking ones get a `--danger` border, Completed ones a green status chip and an evidence block. Owners tick tasks on the page; ticks are saved in this browser only and the page says so. Pages work from the filesystem with no server and no external requests.
- **Files tree (`ProjectFiles`, PM-252/259/282/284):** VS Code's Explorer in this app's tokens. A chevron caret
  per folder (turns down when open, a 32 x 44 touch target on phones), a line icon per file type
  (`fileIcons.tsx`: exact name first, then extension, tones from tokens), indent guides, type-ahead, the ARIA
  tree keys, F2 rename. **Pinned** (PM-284): a collapsible list above the tree of items you keep returning to,
  for this project only or for every project by relative path (an "All" badge). A pin whose path is absent in a
  project is dimmed with "missing". Pin from the context menu or with Alt+P (this project) and Alt+Shift+P
  (all projects); the row's "..." menu moves a pin up or down within its scope, or unpins it. Pins are kept in
  this app's database (never in the project) and can only be changed on this computer; they are read everywhere.
- **Folder previewer (`FolderView`, PM-286):** selecting a folder (in the tree, from a pin, a breadcrumb or a
  subfolder) shows its contents in the right pane instead of the last file: every entry with size and times as a
  Grid of thumbnails or a List; filters (name, type chips, modified range via `Dropdown`, bordered Include subfolders
  checkbox pill with SVG checkmark) and sort (`Dropdown` + icon direction toggle + Clear filters), kept in the
  address and remembered across folders and items (`pm.folderView`), so Images chosen in a folder stays on as you
  move around; a
  "New" or "Changed" badge on what changed since you last looked (with Mark all seen). Pictures bigger than 2 MB
  show an icon instead of loading the whole file as a thumbnail; only a page (120) of entries is in the page at a
  time. A picture opens in a **lightbox** (`ImageViewer`): dimmed backdrop, the picture centred on it, chevrons,
  caption, filmstrip, zoom and pan, an info card; the dark around the picture or Escape closes it. On a phone the
  filters are a bottom sheet and every target is 44px. Lists and the pane keep their size while loading and the tree
  scrolls only itself, so picking something never moves the page.
- **Context menu (`ContextMenu`, shared by the Preview tabs and the Files tree):** a real
  `role="menu"` (arrow keys, Home and End, Escape or Tab close, focus on the first enabled item and back
  on the trigger), closed by an outside click, a window blur or a resize. It is measured before paint
  and opens below/right of the pointer, flipping above/left when there is no room (`placeMenu`), and
  scrolls if taller than the window (PM-268). 30px items (40px on touch), divider rules between groups. Use it for any new right-click menu; do
  not write another. **Files tree menu (PM-259):** right click, Shift+F10 or the Menu key; touch
  screens get a 40px "..." button on every row, and the tree itself is sized for touch there: 44px
  rows, 15px names, 18px icons and a 20px indent step (13px / 14px with a mouse). Open in preview (Expand or Collapse for folders), Open
  in system app, Reveal in file manager, Copy path (absolute, in the project's own slash style), Copy
  relative path, Rename. **Rename is in place** (F2 too): the name without its extension is selected,
  Enter renames, Escape or leaving the field cancels, so it only happens on purpose; a refusal shows in
  the error banner and the old name stays. After a rename the tree, the focus and the open file's
  address follow the new name.
- **Inbox (top bar, left of the theme switch):** a bell with a count badge of what is new: red
  (`--danger`) when something needs a decision or failed, `--accent` when only finished replies wait.
  It polls every 5 s while the tab is visible. The panel (420px; Escape or an outside click closes it)
  has a sticky header (counts, Mark all seen) with **filter chips** under it (All, New, then one per
  kind with rows: Decisions, Problems, Limits, Your turn; remembered per browser; a chip whose rows
  are gone falls back to All), then sections in urgency order: Needs a decision
  (`tailState` input), Problems (failed restart, with its error and a Restart button), Usage limits
  (reset time), Finished · your turn (idle after answering your last message). Each row is a card
  with a coloured left edge per section, and it says what the session is ON: the question with its
  choices as buttons (the screen is re-read before sending, so a changed prompt is never answered),
  or the start of the unread reply with a Reply box. The title opens the session
  (`/workspace?open=<id>`) in the view last used: a pane in Panes, or its selected row with the
  docked terminal in List, clearing list filters that would hide it. Seen state is per browser (localStorage, keyed by session + your last
  message, so the next turn comes back); seen rows dim. Times are shown only when they mean
  something (the reply's own time, the failed restart). 36px button; 44px buttons on touch. Phones
  (≤640px): the panel is a sheet under the top bar, the full width minus 8px gutters, choices fill
  the row, and the reply field is 16px so iOS doesn't zoom.
- **Filter chips (`FilterChips`):** a scrollbar-free strip of pill chips with counts (after
  TrendRelay's FilterChipStrip). It drags with the mouse and pans on touch, with fades at whichever
  end still has chips, and arrow keys/Home/End move between chips. The chosen chip uses
  `--accent-soft`; `data-tone` (review, danger, progress, accent) colours its dot to match the rows.
  26px chips, 36px on touch. Use it for any new chip filter.
- **Preview page (`/preview`):** full width (`.page-wide`, no centred 1280px column) and without a
  visible page header. A list panel (190-230px, sticky) beside a small browser, modelled on the one
  built into Claude's desktop app. **Tabs** (36px strip, up to 12; Chrome's widths: each is 240px while they fit, never wider, so a lone tab never fills a wide pane; once they don't fit they share the strip equally, down to 72px, then it scrolls; + always sits right after the last tab): each shows the page's own icon
  and title, a close ×, and a busy ring while it loads; "+" opens a new blank tab next to the current
  one with the address field focused. The tab pattern: one tablist with a single tab stop, Left and
  Right (also Home and End) move between tabs and show them, Delete closes, Alt+Left and Alt+Right
  reorder (the keyboard way to do what dragging does), a middle click closes, drag reorders, and
  Shift+F10 or the Menu key opens the **context menu**, as does a right click: New tab to the right,
  Reload, Duplicate, Pin or Unpin (pinned tabs are icon-only, always first, kept by "close other
  tabs", and have no ×), Copy address, Move left and right, Close, Close other tabs, Close tabs to
  the right, Reopen closed tab (last 10). The menu is a real `role="menu"` with arrow keys, Home and
  End, Escape returning focus to the tab, and it stays on screen. Every open page keeps its own
  frame, hidden when not shown, so switching tabs keeps scroll, forms and running apps. A click on a
  list row opens in the current tab; Ctrl, ⌘ or a middle click opens a new tab. The tabs are
  remembered per browser across reloads. On a phone the strip shows only once there is more than
  one tab. Below the tabs, a toolbar of Back, Forward, Reload (28px ghost icon buttons; Back and
  Forward are per tab), one address field (28px, tinted, 13px; 16px and 40px on touch) and a
  bookmark that saves or removes a Quick launch. Back and forward walk the pages you opened in the
  tab. The empty browser shows a globe, "Browse localhost" and a line of help. Theme tokens only,
  so it follows the selected theme.
  The list: the shared compact `Dropdown` for sort (Port, Name A-Z / Z-A, Project) and a 26px
  refresh icon button (40px on touch) that reads the machine now and spins while it works; the list
  also refreshes every 5 s while the page is visible and stops in a background tab. Your projects'
  apps split by what a dev stack looks like: **Apps** first (its "/" answered with a real web page, so
  the front end; the icon is only its picture), then **Services** (no page, usually an API or back end),
  then **Other on this computer** (not started from one of your projects; mostly system services,
  so it starts closed unless it is all there is), then **Quick launches**. Headings are real
  buttons (`aria-expanded`, a row count, a tooltip saying what the group means); the folds and the
  sort are remembered per browser. Rows are one line: the app's own 18px icon (a lettered tile
  until it loads), its page title, `:port` on the right; the project and command are in the
  tooltip. Under 769px the toolbar comes first, then the list or the browser (never both), with an
  "Apps" button back to the list and no tab strip. Phones reach Preview from the Agents tools menu
  beside Orchestrators, not the bottom bar.
- **Loading mark (`LoadingMark`, after TrendRelay):** the ProjectManager logo animated as a wait
  indicator: the three board columns rise in turn on the accent tile. Pure CSS on an inline SVG,
  theme tokens only, no script or timer. It is decorative (`aria-hidden`); the caption beside it
  sits in a `role="status"` region. Reduced motion slows it to a gentle glow instead of freezing
  it. The Preview viewer shows it dead centre over the themed stage (the mark itself is centred,
  the caption hangs below it) until the frame reports it has loaded. The stage uses `--surface`
  and `--border`, so the viewer follows the selected theme; the page inside brings its own colours.
- **Dropdowns:** always the shared `Dropdown` atom (`components/Dropdown.tsx`), never a native
  `<select>`: its OS rendering breaks the design language. In forms (`.field`, `.dispatch-row`,
  `.session-form-row`) the trigger grows to 32px at normal weight to match the text boxes beside it;
  toolbars keep the compact 26px trigger. Pass `id` to name it with a visible `<label htmlFor>`.
  Anatomy follows KDP's `opp-select`:
  button trigger with rotating caret, absolute listbox (4px gap, 240px max scroll), accent + bold +
  ✓ selected state, disabled options with a reason, outside-click/Esc close, full arrow/Home/End/
  Enter keyboard support with focus return. Options may carry a one-line `sub` explaining the
  choice (e.g. a board preset's column chain).
- **Dialogs:** native `<dialog>` with `showModal()`, which gives focus trapping, Esc to close and a
  backdrop. Layout is `.dialog-body` + `.dialog-footer` (destructive action on the left, Cancel and
  primary action on the right).
- **Destructive actions:** `ConfirmDelete` (`components/ConfirmDelete.tsx`): a danger button
  (icon-only in dense rows, labelled elsewhere) opens a small confirmation dialog that names the
  action and its consequence ("Stop tracking X? … Files on disk are not touched."), with Cancel
  focused and a solid red confirm. Esc cancels. Other consequential actions that aren't deletions
  (merging a pull request) use the same component with `tone="primary"` and `icon={null}`.
- **Standard web conventions** over platform-flavoured controls: labelled menu buttons instead
  of tiny segmented icon switches, text-labelled confirmations instead of icon-only morphing
  widgets, plain lists/charts instead of decorative pills.
  Never use `window.confirm`.
- **Tabs (project page):** a plain, stable tab bar (`.tabs` / `role="tablist"`), synced to `?tab=`
  in the URL. Each tab has a fitting 14px stroke icon: grid (Overview), kanban columns (Board),
  terminal prompt (Agents). Icons live in the shared `components/icons.tsx` set (also used by the
  topbar: grid for All projects, terminal for Agents) — inline SVG, no icon dependency,
  `aria-hidden`, inheriting the text color.
  - Tabs never animate or move. Rare UI's GooeyNav was removed because its moving segments were
    distracting.
  - All tab panels stay mounted and inactive ones are hidden, so switching never refetches or
    flashes.
- **Kanban:**
  - Native HTML5 drag-and-drop. A drop indicator line appears above the target card, and the column
    highlights when dropping at its end.
  - Column presets (Settings → Boards): Full flow, Simple (To do/In progress/Done), Capture flow
    (Backlog/In progress/Done). Presets only hide columns — cards keep their statuses everywhere
    else, and the board counts hidden cards instead of losing them.
  - **Keyboard alternative:** open a card (Enter/click) and change its **Column** dropdown. Every
    drag-and-drop action has a non-drag equivalent.
  - New cards go to the **top** of a column. Quick-add stays open for rapid entry; Esc closes it.
  - Card keys (`PM-12`) are always visible in mono so they can be typed into commit messages.
  - **Views (Notion database views):** text tabs above both boards switch between **Board** (the
    Kanban, default) and **List**, with an icon each and a text-coloured underline on the active
    one. The choice is shared by every board and saved per browser (`pm.board.view`).
  - **Board view** column headers (project and global boards) use the same status pill as the
    List view's group headers, so a status reads the same colour in both views.
  - **List view** (`BoardListView`): one collapsible group per visible column, headed by a
    disclosure triangle, a Notion-style status pill (tinted background, coloured dot; `--status-*`
    tokens: grey Backlog, purple To do, blue In progress, amber Review, green Done) and the count,
    with ＋ on the right. Rows are full width, 44px minimum: a round done checkbox (tick = Done, untick = back to
    To do; done titles are struck through), title (two lines max),
    then a properties line (key, project tag on the global board, run badges, time). Each group
    ends in a faint "＋ New" row. Done starts collapsed; collapsed groups are saved per browser
    (`pm.board.collapsed`). Cards move through the card dialog's Column dropdown; the list has no
    drag and drop.
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

**Stability (no layout shift, no flash — portfolio brief addendum 6):**

- Tab switches never blank or refetch from empty: all tab panels stay mounted (`hidden`),
  per-project data caches in module scope and refreshes in the background (board cards, agent
  sessions/runs — the KDP ManuscriptViewer pattern), and hidden tabs never poll or stream
  (`TerminalView` pauses, keeping offset and scrollback).
- Switching projects keys panels by project id and resets the rename box; stale data stays
  visible until the new project loads.
- First-load skeletons mirror the loaded layout (title, subtitle, tabs, content), and the
  header subtitle reserves one line so badges never change its height.

## 8. Motion and Rare UI

[Rare UI](https://rareui.com) components are installed via the shadcn CLI into `client/src/components/ui/`
and are **owned code**: adapt them freely, and keep a header comment saying what changed.

| Component         | Where                       | Adaptation                                                                                              |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GitHubActivity`  | Commit activity heatmap     | `unit` prop added, fed local data, no network, no contributors pill (the Contributors chart lists them) |
| `AnimatedCounter` | All stat tiles (`StatTile`) | none                                                                                                    |

Other rules:

- **License:** MIT + Commons Clause + **attribution**. The README credit (a visible link to
  rareui.com) satisfies it and must stay. The in-app footer credit was removed at the owner's request.
- All Rare UI components honour `prefers-reduced-motion`. Our own CSS animations (spinner, skeleton) are
  turned off under it too.
- Add motion only through Rare UI components or tiny CSS transitions (≤150ms on colour/border).
- To add one: `npx shadcn@latest add swamimalode07/rare-ui/<name>`, then check the diff. The CLI may add
  stray dependencies (it once added an unrelated `cn` package), and some components import `next/*`.

## 8.1 Layout stability (no flicker, no shifting)

Switching tabs or projects must not move anything that stays on screen.

- `.app-main` and `.sidebar` use `scrollbar-gutter: stable`. A short view and a tall view would
  otherwise toggle the scrollbar and shift the centred page sideways (this was the "project name
  moves" bug).
- Tab panels stay mounted (hidden when inactive). Board and agent data are cached per project and
  refresh in the background, so revisits render instantly.
- Skeletons mirror the real layout (title, subtitle, tabs, content), so the first paint lands where
  the content will be.
- Verified by measuring: the title and tabs keep identical coordinates across tab and project
  switches, with no skeleton flashes.

## 9. Accessibility

- Visible `:focus-visible` outline (2px `--focus`) on everything interactive.
- Every input has a label. Icon-only buttons have an `aria-label`.
- Colour is never the only signal: badges carry text, and charts have legends, tables and labels.
- Status changes (auto-moved cards, delete) are announced through `role="status"` regions.
- Contrast: body text uses `--text`/`--text-2` on surfaces (≥ 4.5:1). `--text-3` is for non-essential hints.

## 10. Responsive behaviour

- Desktop-first, usable down to 360px wide: grids collapse, tables scroll horizontally inside
  `.table-wrap`, and board columns share the width, stacking into one column at ≤ 900px.
- **Breakpoints:** 900px (tablet: shell stacks, two-column grids become one) and **768px (phone)**,
  the same mobile breakpoint as the sister apps (KDP, Oracle). `PHONE_QUERY` in
  `client/src/projectPanel.ts` mirrors it for JS.

### 10.1 Phone layout (≤ 768px)

Modelled on the sister apps: KDP's bottom bar and master/detail panes, ApexTide's safe-area
tokens and touch targets.

- **Bottom tab bar** (`MobileTabBar`, 56px + home-indicator inset): Home, Projects, Board, Agents,
  Settings. 20px icons over 11px labels; the active tab is accent-coloured. It is the only
  primary nav on phones; the top bar keeps the brand and the theme menu.
- **Projects panel:** the Projects tab shows the sidebar full screen over the page (one pane at a
  time, KDP master/detail), with its filter, sort, Add and totals intact. Picking a project, any
  navigation, Esc, or the tab again closes it; it is tied to the history entry it opened on
  (`useProjectPanel`). Projects reads active on project pages.
- **Safe areas:** `viewport-fit=cover` plus `--safe-top/right/bottom/left` tokens pad the top bar,
  tab bar, page gutters and bottom sheets. Pinch zoom stays enabled.
- **Headers wrap** instead of truncating: the title gets its own row and actions wrap beneath.
  Project tabs scroll sideways on one line. Panel headers drop their meta under the heading.
- **Boards** keep the original Kanban layout at every width (project columns scroll sideways,
  global columns stack). The touch-friendly alternative is the **List view** (§6), one tap away
  in the view tabs above either board.
- **Dialogs are bottom sheets:** full width, rounded top corners, anchored to the bottom, with the
  footer pinned to the sheet's bottom edge so Save/Cancel stay reachable. The lightbox is exempt.
  No slide-in animation (§8 motion rule).
- **Lists:** dashboard "Being worked on" / "Needs attention" rows put status, key and project on
  line one and the title on line two. Agent work rows move card, state and actions to their own
  line and keep only the provider mark.
- **Agents workspace:** panes stack, each at least `min(480px, 62dvh)` tall; the layout presets and
  shortcut help hide (meaningless without side-by-side panes or a keyboard); pane headers drop
  the agent name so the session name stays readable.
- **Touch (`pointer: coarse`):** buttons 40px (small 34px), inputs and dropdown triggers ≥ 40px,
  pane-header icon buttons 32px, and 16px text in fields so iOS doesn't zoom on focus. Nothing in
  the app is hover-only, so touch sees every control.
- **Browser chrome:** `theme-color` follows the active `--surface` token (`syncThemeColor`).
- **Sticky tops (PM-39):** Home, Board and Settings keep their sticky header on phones, compact:
  8px padding and no descriptive subtitle (Home is title + Add project, about 50px; Board keeps
  New card, filters and the Board/List switch). Project pages (`.sticky-head.phone-tabs-only`)
  let the tall header scroll away and pin only the tab bar.
- **Space savers (PM-36):** project headers scroll away (only the tabs stick, see above); title and
  actions share a row (title keeps ≥ 160px, actions align to the title line; "Scanned …" hides);
  12px gutter and panel padding; stat tiles three across without hints; dashboard lists show five
  rows and a "Show all N" link. Agents: the sentence labels hide so New session is one row
  (project, agent, Start); status chips scroll on one line; pickers share a row, search is full
  width; work rows drop the "started …" fact and keep card · state · actions on one line, with
  "Open"/"Show" short labels (full names stay in `aria-label`). Fact separators never start a
  wrapped line (clipped at the row's inset).
- **Reachability:** phones use **LAN access** (opt-in, `server/lan.ts`, README): same app, same
  layout, behind a sign-in code. The phone layout also serves narrow desktop windows.
- **On another device** (`isRemoteClient()` in `client/src/remote.ts`: the page's host isn't a
  loopback name): computer-only controls step aside. The project path is plain text (folders open
  on the computer; the API refuses it from LAN too), and Settings → LAN access is a short note
  instead of the code and device list. A 401 can only come from the LAN gate (signed out), so the
  API client reloads, at most once per 10s, and the gate's sign-in page takes over (AdRelay's
  stale-session screen).
- **Home screen:** `apple-touch-icon.png` (180px, full bleed; iOS rounds it) plus the
  `apple-mobile-web-app-*` / `mobile-web-app-capable` metas, so Add to Home Screen opens full screen
  with safe areas already handled. No manifest or service worker: LAN access is plain HTTP, where
  browsers don't install PWAs anyway.
- The heatmap (Rare UI) fits as many weeks as the panel width allows and drops the oldest weeks first.

## 11. Platform notes

- Runs in a browser against a local server on 127.0.0.1. There's no native folder picker: the
  "Add project" dialog browses folders through the API (drive letters on Windows).
- The dialog tracks one folder or many at once: tick checkboxes (or "＋ List" the current path)
  to queue folders, then "Track N folders" calls `POST /api/projects/batch` (max 50, per-folder
  skips reported, never failing the whole batch).
- Folders already tracked show a `✓ tracked` badge with a disabled checkbox; the open folder
  shows an "Already tracking as X" notice that disables single-track actions.
- The dialog remembers where you were (localStorage): every browsed folder is saved, and
  tracking a folder saves its parent instead. It reopens there, falling back to home when the
  folder is gone.
- Paths are shown exactly as the OS reports them (backslashes on Windows) in mono.

## 12. Agent CLI sessions and runs

- Terminal history stays hidden only while it is being parsed. A server drain notification
  overrides stale log-byte estimates; stalled streams recover through an HTTP read after 8s.
  Loading and empty-output notices sit in the center of the terminal until the CLI has drawn.
  Once it has, a reconnecting notice stays in the top-right, with Retry.
  Network recovery preserves the CLI process and existing terminal output.
- Restart progress appears independently of terminal action menus. Phone headers use short
  labels (Stopping, Starting, Restoring, Restart failed) in a 16px status line below identity;
  action menus wrap within the viewport rather than stretching the header.

- Mobile Agents rows keep identity, facts/card key, and status/actions in three compact lines.
  Stop is an accessible icon on phones; continuation options live behind a 40px ellipsis with
  an armed dot. Bulk Actions and continuation menus use top-layer popovers above the bottom
  navigation, avoiding clipping inside the scrolling list. Filters and Actions align at 44px.
  The mobile New disclosure uses neutral button styling; Start is the primary action.

- Restart is a single server operation, shared by row, pane and bulk actions. Its progress
  (Stopping, Starting, Restoring conversation) appears in both the row and terminal header.
  Concurrent restarts are rejected; failure remains visible with the reason in the tooltip.
- Codex PTY sessions offer a one-shot Auto-continue opt-in. A recent usage-limit error and
  known exhausted usage-window reset arm a server-side wait with a 30-second margin.
  The header shows the reset time/countdown and cancellation. Submission requires the same
  conversation/process generation, idle state, empty prompt and no queued input. Manual
  input, Stop, Restart or a conversation change cancels it. A gap over 30 minutes requires
  manual continuation. Claude uses its own native auto-continue; we never send a duplicate.

- Interactive terminals take keyboard focus after history replay finishes and when a preserved
  project tab becomes visible. Actual terminal focus shows an accent outline, which
  disappears when focus moves to another control.

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
- **Providers** (Claude Code, Codex, Grok, Antigravity, OpenCode, shell, custom) are PATH-probed with
  install links when missing; dispatches use argv arrays, never a shell. xterm.js renders
  terminal output and is code-split so it loads only with a terminal.
- **Honest activity:** a session reads "running" while the CLI is busy or a shell/subagent it
  started is still going, judged from its last screen frame (the text between its last two
  prompt draws); a prompt with neither reads "idle · waiting for you". Log recency alone lies
  (TUI redraws keep the file fresh for hours) and is only the fallback for unknown CLIs.
- **Agent work rows:** title flush left right after the status dot, provider mark + name after
  it (each CLI's own mark: Claude Code and Antigravity in brand colours; Codex (the OpenAI
  mark), Grok and OpenCode in the text colour; generic terminal glyph for shells and custom commands); card tag, state word and actions sit in fixed
  right-hand columns so they line up on every row.
  A session asking you to choose or approve something (option list, "Enter to confirm", Claude
  permission/question notifications) shows an amber **needs your input** badge with a dot, sorts
  first, has its own "Needs input" filter chip, and turns the sidebar's session badge amber ("!").
  Start / Stop carry an icon as well as the word: a green play triangle and a red square
  (`SessionToggle`), so the two read apart at a glance.
- **Settings (/settings):** one section per concern. First section is agent CLIs: availability,
  and one-click **Install** for whatever is missing, using each vendor's official method
  (native installer scripts for Claude/Codex/Grok/OpenCode-posix; npm globals for
  OpenCode-Windows and Antigravity). The recipe (label, what it downloads, docs link)
  shows before anything runs; execution needs the explicit Install POST; output streams live
  and availability re-probes past the status cache on success. Installs never relaunch after
  a restart — retry by hand. Same-machine trust model and caps apply.
- **Usage limits (PM-17):** under a CLI's name, one line per plan window (5-hour, Weekly): label,
  a thin 6px meter (accent; amber from 75%, red from 90%), the percentage, and "resets in 4h 5m".
  The meter is `role="meter"` and the number is always printed, so colour is never the only
  signal. Numbers come only from what the CLI records locally (no tokens spent, no credentials
  read; `server/agents/limits.ts`): Codex logs `rate_limits` in its session rollouts. They are as
  of the CLI's last reply (tooltip: source and time); a window that reset since reads 0% "reset
  since". CLIs without a local source show no meter, never an estimate. Claude Code exposes its
  limits only to a status-line command's JSON (`rate_limits.five_hour` / `seven_day`), so the
  Claude sessions ProjectManager launches get `scripts/claude-statusline.mjs` as status line
  (in the same injected `--settings` as the hooks): it saves that block to
  `<dataDir>/claude-limits.json`, then runs the user's own status line (project-local, project,
  then user settings; PowerShell on Windows, sh elsewhere) and passes its output through, so
  what they see is unchanged. Resets read: "in 3h 49m" within a day, else the date,
  time and timezone (e.g. "Sat, Oct 31, 1:21 AM GMT+7") in the viewer's timezone (`formatReset`).
- **Sidebar plan usage (PM-41):** a card above the totals in the sidebar footer, after Claude
  Code's usage popover: per CLI a name row, then each window as label · "Resets …" · percent with
  a 4px bar beneath (amber from 75%, red from 90%). The header collapses it to a one-line summary
  ("Claude Code 94% · Codex 28%", highest window per CLI), saved per browser. Hidden when no CLI
  reports limits.
- **One account per CLI:** the Codex account selected in Settings is the login for every Codex
  session, run and orchestrator chat. There is no separate account on an individual CLI.
  Choosing another account moves all of them; a different login starts a new conversation.
- **Limits on Agent work (PM-18):** limits belong to the account, not a session or run, so they
  appear once per CLI: on the project Agents tab as a slim section of its own below Agent work
  and its terminal (PM-42); in the workspace List view inside the toolbar's free middle (PM-50),
  so it costs the terminal no height (on phones it is its own row that scrolls sideways). On
  phones the section's cards take the width, name above both windows (PM-52),
  only for CLIs present in that list: icon, name, then each window as label, 40px meter and
  percent; reset time and source in tooltips. No row repeats them; no CLI without data shows.
- **Trust model:** same-machine only (existing Host allowlist + JSON-write guard). Sessions
  run as your user with your environment; logs live under `data/agent-logs/` (gitignored).
  Caps: 8 sessions/project, 3 active runs/project, at most `MAX_PARALLEL_RUNS` runs executing
  machine-wide (CPU threads / 4, between 1 and 4; the rest wait as `queued`), 8MB logs, 20min
  default run timeout.
- **CPU budget (Settings, below Agent permissions):** one dropdown, "N of M threads (P%)", with
  1, every even count and "All M threads (no limit)"; the default (3/4 of threads, even) is
  marked "recommended". Agent processes are pinned to the highest-numbered CPUs (CPU 0 stays
  free) at below-normal priority; both are inherited by everything an agent starts. Applies at
  once; macOS shows "Not available on this system".

### 12.1 How the CLI integration works (verified 2026-10-05 on Windows)

- **Terminals are real PTYs.** Sessions run in a pseudo-terminal (`node-pty`, an optional dependency
  with prebuilt Windows/macOS binaries). Interactive CLIs such as `claude` need a TTY: over plain
  pipes they wait for EOF and show nothing. The browser terminal is interactive: click it and
  type. Every keystroke (Ctrl+C, arrows, Tab) goes to the process. Output streams live over
  server-sent events (`GET /agent-sessions/:id/stream`), and the PTY is resized to match the
  visible terminal. Without node-pty, sessions fall back to line-based pipes, shown with a
  `pipe` badge and a line input.
- **Launching without a shell.** On Windows, npm-installed CLIs (`codex`,
  `opencode`) are `.cmd` shims, which Node can't spawn without cmd.exe. cmd.exe would mangle
  prompts and can't pass newlines at all. `server/agents/resolve.ts` reads the npm shim and runs
  its target directly (`node <cli.js>` or the bundled `.exe`). "Available" in the provider list
  means "resolves to something launchable", and the reason is shown when it doesn't.
- **Autonomy per run.** Print/exec modes can't ask for approval, so without a flag an agent's
  edits are silently declined and the run still exits 0. Every dispatch picks a level:
  **Read-only** / **Edit files** (default) / **Full access**, mapped to each CLI's own flags
  (`--permission-mode`, `--sandbox`, `--approval-mode`, `--auto`). Levels a CLI lacks are disabled.
- **Evidence before validation.** The supervisor snapshots `git status`/HEAD before a run and
  records the files changed and commits made afterwards. The run card shows "3 files changed ·
  1 commit" (expandable). A successful run that changed nothing gets a warning so it isn't
  accepted blindly.
- **Clean agent environment.** Agents never inherit the _launching_ session's markers
  (`CLAUDECODE`, `CLAUDE_CODE_SESSION_*`, `CLAUDE_CODE_MESSAGING_*`, …). Inheriting them makes
  `claude` behave as a nested child session and would hand it the parent's messaging token. User
  configuration (`ANTHROPIC_*`, `CLAUDE_CODE_USE_BEDROCK`, …) is kept.
- **Record identity.** SQLite reuses row ids after deletes. Async callbacks (process exit, run
  completion) therefore act only on the record whose unique `log_path` matches. Deleting a session
  evicts its live process and log immediately, so a new session with the same id can never inherit
  the old one's output or be killed by its late exit.

### 12.2 Agent workspace (multi-pane)

- **Where:** the top bar's **Agents** link opens `/workspace`. It's full width with no project
  sidebar or footer, so terminals get the screen.
- **Layouts are presets, not free-form splits** (`WORKSPACE_PRESETS`): 1 pane, 2 side by side,
  2 stacked, 3 side by side, 2×2. One click switches layout. Sessions keep their order, and
  sessions that no longer fit are only hidden (they keep running and stay in the empty-pane
  picker).
- **Chrome budget:** a single 40px toolbar (title, layout picker, inline "New session") and 28px
  pane headers. A header shows a status dot, the session name, project link and card link, plus
  stop/start, maximise (also by double-clicking the header) and remove-from-layout. Removing a
  pane never kills the session.
- **Coming back to a section** (PM-72, `client/src/sectionMemory.ts`): the top bar and the phone
  tab bar link each section to the address last open in it (e.g. the Board filtered to one
  project), every address restores its scroll position, and the Agents page reopens the terminal
  that was open. Kept per browser tab (sessionStorage).
- **Orchestrators on a phone** (PM-71): not in the bottom tab bar; reached from the Agents tools
  menu (⋯), and the Agents tab stays highlighted while on Orchestrators.
- **Agents on a phone** (PM-62): the filter bar is one row (status picker, Filters toggle);
  expanded, agent / project / kind sit side by side in three columns, then search with an inline
  Clear. Each work row is two lines: identity (dot, agent, name, project), then the state word,
  the facts (one line, cut with "…") and the actions at the right (40px targets).
- **Closing an empty pane** (`closeEmptyPane`, PM-63): an empty pane's header has
  "Show a session here" on the left and ✕ at the far right. It removes that pane and steps the
  layout down one size (2×2 → three columns → two → one), keeping every session in order. No ✕
  when it's the only pane.
- **Opening sessions** (`placeSession`): a session already shown stays put. Otherwise it goes in
  the first empty pane. If every pane is full, the layout grows (1 → 2 → 2×2), and at 2×2 it
  replaces the last pane. Entry points:
  - `?open=<sessionId>` from a card's "Work on it in a terminal"
  - the card dialog's "Open live terminal"
  - "Open in workspace" in a project's Agents tab
- **Persistence:** the layout (preset, pane → session ids, maximised pane) is stored server-side
  (`settings` table, `GET/PUT /api/workspace`), so it survives reloads, restarts and reboots.
  Panes whose session was deleted heal to empty on load.
- **Board integration:**
  - "Work on it in a terminal" starts an interactive session linked to the card (`card_id`),
    primed with the card's task. The card moves to In progress.
  - While the session runs, the card shows a **⌨ live** badge, and its dialog links to the
    terminal.
  - Claude sessions pin their conversation id (`--session-id`), so after a reboot each pane
    resumes _its own_ conversation (`--resume <id>`), even with several Claude panes in one
    project.
- **Efficiency:**
  - Only visible panes mount xterm and open an output stream; a maximised pane hides the rest.
  - The session list is polled every 4s for statuses only. Output is live over SSE.
  - Keystrokes are batched per ~12ms and sent in order.
- **Toolbar** (one row, each group with a distinct, labelled purpose, separated by thin dividers):
  - **Layout:** a segmented group of the five preset icons.
  - **Text size:** a − / value / + stepper.
  - **?** opens a small shortcuts card (closes on Esc or an outside click). There's no permanent
    hint text.
  - On the right, the new-session controls read as a sentence: "New session in [project] with
    [agent] [Start]".
- **Keyboard:** Alt+1…4 focuses pane N (or switches the maximised pane), and Alt+Enter maximises or
  restores the focused pane. These are captured before xterm, so CLIs never see them. Pane headers
  show their number.
- **Drag a pane header** onto another pane (or an empty one) to swap them. The drop target is
  outlined.
- **Font size:** A−/A+ in the toolbar (10–20px). It's saved with the layout and applied live
  without re-creating terminals.
- **Card sessions** have a "→ Review" header action that moves the linked card to Review when the
  work looks done.
- **Touch in terminals (PM-53):** xterm has no touch scrolling (its canvas takes the swipe), so a
  vertical swipe is replayed as the wheel a mouse would send: scrollback in plain output, and the
  CLI's own scrolling where it turned mouse mode on (Claude Code, Codex get the same wheel reports
  as from a desktop mouse). The swipe never scrolls the page around the terminal.
- **Images into a session (PM-54):** phones have no Alt+V (that reads the computer's clipboard),
  so images travel as files. Every running PTY session's terminal header has an Image button
  (photo picker / camera on phones); pasting or dropping an image on a terminal does the same.
  The browser re-encodes big photos (long edge 2000px, JPEG) and uploads to
  `<dataDir>/attachments/sessions/<id>/` (8 MB cap, newest 50 kept, removed with the session),
  then pastes the absolute path through xterm's paste (bracketed when the CLI asked), which
  Claude Code shows as `[Image #1]` (verified live). Alt+V and Ctrl+V for text are unchanged.
- **Filters (PM-53):** the search box flexes 120-220px to share the filter row; below 1200px the
  session count steps aside for it; on phones it is a short "Search…" box beside the three
  pickers that takes the whole row while in use.
- **List view space (PM-50):** no title row (the page says "Agents"; the count sits at the end
  of the filter row, hidden on phones). With a session docked, the terminal takes the height and
  the list keeps about three rows (216px; 140px on phones) until the edge is dragged; a dragged
  height is remembered, double-click returns to this default.
- **Narrow screens** (< 900px): panes stack vertically with a minimum height and the grid
  scrolls. Phones: see §10.1.

### 12.x Chat view on phones (branch `mobile-chat-view`)

A terminal UI is heavy on a phone (a full screen of cells redrawn, whole-row scrolling, the
on-screen keyboard), so on phones and touch screens a Claude Code or Codex session opens as a
chat. Its pane header has a **Chat | CLI** switch, remembered per device (`pm.sessionView`).

- The chat renders the CLI's own transcript (`GET /api/agent-sessions/:id/transcript`, read
  incrementally from `~/.claude/projects` or `~/.codex/sessions` by the session's exact
  conversation id; only the last 2 MB at first, then new bytes, refreshed every 1.5 s while
  visible). Nothing is dropped: replies (light Markdown: code, tables, headings, bold), and
  tool calls with their full input and output, one tap away.
- Consecutive tool calls fold into one **N steps** row (tools used, latest step, running /
  failed state), like chat apps do, so the agent's messages stand out.
- A composer sends to the same session (bracketed paste, then Enter; Return adds a line on
  phones, Ctrl/⌘+Enter sends on keyboards); quick keys (Esc, arrows, Enter, 1–3, ^C) answer
  menus; while the CLI asks something, its current screen shows above them
  (`GET /api/agent-sessions/:id/screen`).
- Other CLIs, and desktop, keep the terminal.

## 13. Spacing, alignment and symmetry

Every margin, padding and gap in `styles.css` comes from one scale, and every box is
symmetric unless it has a functional reason not to be. New CSS must use the scale; one-off
values (5px, 7px, 9px, 18px…) are never added.

- **Scale:** 0, 1 (hairline dividers), 2 (dense rows), 4 (badges, menu padding), 6 (form rows,
  toolbar rows), 8 (panels' inner rhythm, option rows), 10/12 (cards, tiles), 14/16 (sections,
  panels), 20 (dialog rhythm), 24 (`--gutter`, 16 at phone width).
- **Symmetry:** padding shorthands are symmetric on both axes (`8px`, `6px 8px`, `10px 12px`).
  Asymmetry needs a functional reason stated in a comment — e.g. `.pane-head` keeps a slimmer
  right edge because icon buttons sit flush there, and `.chip` keeps extra left padding for
  its remove button.
- **Balance:** rows that mix text and controls hold one line (title truncates, actions keep
  fixed slots — see §2); icon-only buttons are square-ish (22–32px); menus and dialogs share
  the 4px outer / 7–8px row padding with the sorter and dropdown atoms.
- **Audit trail:** normalised to the scale — tooltip `6px 9px` → `6px 8px`, project figures
  and list indents `18px` → `16px`, workspace padding → symmetric `8px`, pane-body gutters →
  `6px 0 0 6px`, sidebar microcopy gap `5px` → `6px`, dropdown rows `7px 9px` → `7px 8px`.

### 12.3 Session persistence (session host)

Sessions are never lost unless you stop or delete them (owner requirement, Research Addendum 4).

- **Session host** (`server/agents/host/ptyHost.ts`): one small background process per data
  folder owns the interactive session processes (PTYs), like tmux. A quick server restart (dev
  reload) only detaches from it. The next server re-attaches to the same processes: same PID, no
  relaunch, no lost state.
- **Closing ProjectManager:** once no server has been attached for 20s (`ORPHAN_MS`: closed
  window, Ctrl+C, Task Manager, crash) the host ends every session's process tree and exits, so
  no agent CLI keeps using CPU unseen. Sessions stay wanted and relaunch on the next start.
- **Reboots:** the host dies with the machine. On the next start the supervisor relaunches every
  wanted session, and Claude resumes its own conversation (`--resume <id>`).
- **Isolation:**
  - It runs outside the server's process tree (started via a short-lived intermediate), so killing
    the server tree never kills sessions.
  - It talks newline-JSON over a local named pipe / unix socket. Every client must authenticate
    with a token from `<dataDir>/agent-host.json`.
- **Logs:** the host writes session output straight to the log file, so nothing is missed while no
  server is attached. Attached servers mirror it from live events carrying exact byte offsets. Only
  one writer touches a log at a time. Logs are capped at 32 MB on disk: a full log is compacted
  to its last 1 MB and the bytes dropped from its head go in a `<log>.base` sidecar, so offsets
  only ever grow (`server/agents/logFile.ts`). Output never stops streaming at the cap (it used
  to, which left restarted OpenCode sessions blank with no input box).
- **Efficiency:** the host exits on its own once no server is attached and its sessions have
  ended.
- **Simpler UI:** the "Supervise" option was removed. Every session persists by default.
- Disable with `AGENT_HOST=off` (sessions then run inside the server as before).

## Oct 06: cards, board tools and pull requests

- New card and Edit card use the same CardDialog fields and agent/session controls. Global creation
  requires a project; agent choices load for that project. Images stage locally until creation.
  Cancel before creation leaves no card. Sending saves current title/notes and uploads images first.
- Backend sessions/runs remain distinct for lifecycle purposes; the UI presents one Agent work list.
  Pane and List views share rows, with a resizable terminal dock in List view.
- System/Light/Dark uses a labelled theme menu, calm grey surfaces and desaturated accents.
- Pull requests is a remembered project tab. Fetch on first opening, explicit Refresh thereafter;
  preserve loaded rows during refresh. List open PR title/link, author, branches, draft/review state
  and update date. Missing gh/auth/non-GitHub errors appear inside the panel.
- (Oct 11) The tab acts on PRs like GitHub's page. An Open/Closed segmented switch; each row shows a
  merge-readiness `status-pill` (Ready to merge, Mergeable, Behind base, Blocked, Conflicts, Draft,
  Merged, Closed) and a checks summary. "Actions" expands a full-width row: the reason it can or
  can't merge, the checks list, a merge-method `Dropdown` (methods the repo disallows are disabled),
  delete-branch and admin-bypass checkboxes, Merge / Enable auto-merge / Update branch, Ready or
  Convert to draft, Close, and Open on GitHub. Closed rows offer Reopen, Delete branch and Restore
  branch. Merge, close and delete confirm in a `ConfirmDelete` dialog; gh's stderr shows inline in
  the row, a success notice above the table, and the list refreshes after every action.
- Agent board tools are scoped to the owner's assigned card. add_note appends evidence; status
  changes and notes have a persistent audit visible through Agent board history. Native MCP image
  reads avoid relying on browser-terminal clipboard emulation.

## Batch terminal delivery feedback

Batch messaging preserves recipient names and completed progress. Message chunks and Enter require server acknowledgments; queued input is distinguished from confirmed delivery. Each terminal has a result. Entirely delivered batches show a three-second summary before closing. Failures and queued input stay open; only failed recipients can be retried, with a partial-input warning. Delivery confirms input acceptance, not an agent reply.

Settings Agent CLI rows vertically center installation badges, install controls and status dots against the full row, including wrapped descriptions and quota information.

Mobile terminal helpers include Paste and Ctrl+A. Paste opens a body-level native editable field for image/text clipboard events on HTTP LAN pages; Read clipboard is available when supported. Pasted text never submits Enter. Browser clipboard restrictions retain Add images as the fallback.

Orchestrators alternate project task queues, preserving board order within each project and preferring least recently served projects. Preview capacity includes proposed workers as well as live workers.

### Project Agents work navigation (PM-64)

On wide desktops the project Agents page uses the available width: a 320px Sessions and runs
pane sits beside All projects, with session creation and selected terminal/run in the main
column. The work pane scrolls independently and keeps state, selection, rename and actions.
At 1200px and below it becomes a collapsible section above the selected work, with bounded
height and 44px phone actions. Only one terminal instance is mounted.
Ctrl+Up/Down inside the project pane opens the adjacent visible project and retains keyboard
focus there; editable controls keep their own shortcuts. Terminal shortcuts remain separate.

Orchestrators use a compact chooser and one selected workspace. The chooser becomes a
horizontal scrolling row on phones; Activity and counts follow the selected orchestrator.
Dispatched runs remain available in its workspace with output, stop/retry and review controls.
Status chips support Shift-click to add or remove statuses; normal clicks select one. The
mobile Status menu supports the same selection without a modifier key.
Project CLI uses a bounded workspace: resizing transfers space from the session list above,
keeping the bottom edge anchored. Mobile header keeps the dot beside the name and hides
path/process metadata to avoid wrapping the identity into separate rows.

Orchestrator chat handles authorized project changes directly in its session. One-time checks include Needs attention for dashboard alerts; scheduler dispatch and limits remain separate.

The Sessions and runs information button opens a native modal dialog in the top layer, constrained to the viewport with scrollable content and a Close button. It remains readable inside clipped project panels on phones.

Orchestrator chat shows its explicitly reported card or repository task above the terminal, linked to its project. Idle chats label it Last reported task; stopped or replaced sessions cannot show live work.

Dashboard API reads share identical in-flight GETs and fetch fresh data after completion. JSON responses negotiate compression; terminal event streams remain uncompressed to preserve immediate updates.

OpenCode and Grok PTY sessions now share the mobile Chat/CLI switch, message composer, image attachments, quick keys and expandable tool details. OpenCode reads its pinned SQLite conversation; Grok reads pinned JSONL updates. Provider snapshots replace changed streamed parts without duplicate messages; long history remains available in CLI view.

On phones, account toolbar actions (refresh all usage, save current login, import/cancel) use the same icon buttons as account-row actions. Accessible names and tooltips remain; touch targets stay at least 44px. Desktop retains text labels.

PM-192: shared Dropdown menus with 8+ options include a searchable list; short lists retain their existing presentation (callers may override searchable). Filtering matches label, description and hint without accent/case sensitivity, never changes selection by itself, and reports no matches. Keyboard arrows/Enter/Escape and multi-select remain supported. Search fits inside the existing viewport-bounded popup with a 32px input row and 16px text to avoid iPhone focus zoom. Closed trigger sizing and the 360px menu cap remain unchanged; no permanent extra control or enlarged field. Browser/Windows runtime initialization failed with "failed to write kernel assets ... os error 3", so physical phone visual QA remains outstanding.

PM-197: saved Codex profiles default to inclusion in automatic switching. With global automatic switching enabled, each saved row offers Include in automatic switching; opt-outs persist in the profile registry and nextUnused skips them, including unknown/exhausted fallback selection. Manual switching stays available. Turning global automation off hides the row controls without resetting eligibility. No saved credential content is returned or changed. Focused account regressions: 22 passing, covering persistence/defaults/rotation/manual selection and conditional UI. Server reload is needed for the new eligibility endpoint and selection behavior.

PM-198: account Auto-switch checkbox now sits inline beside metadata, wraps on narrow screens and retains its full accessible label. Credential switches merge local session indexes and copy missing/newer rollouts from the default and saved profile homes into the selected home; conversations are deduplicated by id, newest copies win, sealed reasoning is filtered on cross-account carry and authentication stays separate. Failed rollout carry refuses selection. 23 account tests pass, including two-way resume-history preservation, typecheck and focused lint pass. Requires server reload; native CLI picker end-to-end acceptance remains to verify without disrupting running sessions.

PM-288: an info button beside "Automatically switch accounts when hitting usage limits" opens a dialog stating the rule. Auto-switch waits for Codex itself to report the limit at an idle prompt (a turn still finishing after 100% is never cut off), then picks the account with the most usable quota (the lower of its 5-hour and weekly remaining), then the most weekly left, then the Settings list order, in whole percents. It skips accounts with Auto-switch off, any limit at 100% or usage older than a minute, and stays put when none qualify. Reorder accounts is saved on the server (the browser copy is dropped after saving), so every device shows the order auto-switch uses.

PM-196: Claude saved profiles now display usage from credential-specific statusline snapshots instead of hardcoded unsupported. Statusline identity is a SHA256 fingerprint pinned at session launch; no token is included in settings command or returned payload. A session started before identity pinning continues only the global cache. Only matching snapshots populate account rows; missing shows not_loaded, expired snapshot stale. Selected profile reads live refreshed credential. Requires server reload and newly started/relaunched Claude session reply to collect attributable usage; no login switched or model call made. Validation:23 focused account/UI/limits tests passed, then14 attribution/limits tests after launch-pin hardening; types/lint/diff checks pass. Existing unrelated shared changes and scratch test preserved.

Settings is split into tabs (`?tab=`): Agents (CLIs, permissions, CPU budget, installs), Access (LAN, Remote), Boards, Shortcuts. Panels stay mounted while hidden; arrow/Home/End keys move between tabs. Remote access is three numbered inset steps (`.remote-step`) with a two-column field grid that collapses to one column on phones.
