# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser editor for task dependency graphs (DAGs): the user types task names, connects them, and Graphviz lays them out. Live at https://monsym.se/dag/.

Plain HTML + CSS + jQuery, with no build step, package manager, linter or test suite. Three source files: `index.html` (markup, ☰ menu, help dialog, properties panel), `style.css`, `app.js`. Libraries load from CDNs in `index.html`: jQuery 3.7.1, `@viz-js/viz` 3.4.0 (Graphviz compiled to WASM), SweetAlert2 11.

## Running

Serve the directory with any static server, e.g. `python3 -m http.server 8000`, and open http://localhost:8000/. Example graphs in `examples/` can be loaded via ☰ → Open…. There are no automated tests, so check changes in the browser.

## Architecture of `app.js`

Everything lives in one jQuery ready closure (`$(function () { 'use strict'; … })`), split into sections marked `// ----…---- <name>` (model, view, time legend, tasks, edges, date conflicts, critical path, folded groups, connecting, layout, overlap, save / load, undo / redo, input, menu, days / hours, box order, help, pan & zoom, properties panel, resolve conflicts, auto-schedule, pointer input, share links). Grep for the marker to find a section.

**Model.** `tasks` (Map `t<n>` → task, including its DOM `$el` and current position), `edges` (array of `{from, to, wait}`), `orderHints` (user-chosen order within a rank), `folds`/`foldOf` (a closed subgraph from an entry task to an exit task shown as one box with id `f<n>`; its member tasks stay in the model). Use `nodeOf(id)` / `nodeObj(id)` / `shownNodes()` / `nodeEdges()` when working with what's on screen, since a folded task is drawn as its fold.

**The `changed()` pipeline.** Every edit ends with `changed(opts)`, which recomputes derived state (`refreshFolds`, `updateHiddenEdges` = transitive reduction for display, `updateConflicts`, `updateCritical`, `updateMovable`), calls `layout()`, autosaves via `saveLocal()` and records an undo snapshot. New edits should mutate the model and then call `changed()`, not lay out or save themselves. `opts.coalesce` merges a stream of edits (typing) into one undo step; `opts.quiet` suppresses conflict notices.

**Layout.** `layout()` builds DOT with `dotSource()`, renders it with viz.js to JSON, and turns node positions into target positions plus Graphviz's bézier arc routes; `animateTo()` then tweens the boxes. Graphviz decides the rank (column/row) by dependency order, not by date. Arcs follow Graphviz splines only while boxes sit where Graphviz put them; while animating or dragging they use the simple `edgePath()` curve. Tasks without arcs ("loose") are placed by the app into the slots Graphviz left, and can be dragged by hand (`pinned`). A `layoutSeq` counter discards stale async layouts.

**Time.** On the `moment` branch each box is a *moment*: a single `time` (no start, end or duration), though the code still names them tasks (`tasks`, `createTask`, `renderTask`). An arc A → B means B.time ≥ A.time + wait, so without a wait the same day/minute is allowed. Two modes (`hourMode`): days (`YYYY-MM-DD`) and hours (`YYYY-MM-DDTHH:MM`, minutes). Go through the mode-aware helpers (`parseTime`, `formatTime`, `parseDuration`, `durationValue`, `minGap(e)`) rather than parsing dates directly; "durations" now only mean waits and slack. Waits can be set per arc (`e.wait`) or for the whole graph (`graphWait`). A fold of moments is shown to the user as a **phase** (code: `folds`, `createFold`): any set of moments the user picked (`picked`, Shift/⌘-click or long-press then tap, grouped by the `#pickbar`'s "Group to phase" → `groupPicked()`), closed under `between()` so no path leaves the phase and comes back; `refreshFolds()` re-applies that closure after every edit. Arcs to a folded phase's box go to all its first moments (`phaseSources`) and arcs from it leave all its last ones (`phaseSinks`), via `boxArcs()`/`arcProblem()`. It carries `start`/`end` (its first and last moment) for display and the legend. Phases nest (laminar: two phases are disjoint or one `contains()` the other; `nestProblem()` enforces it). A phase is closed (one box) or `open` (contents shown, laid out as a Graphviz cluster, with a `.phase-frame` drawn around them by `drawFrames()`); it is `visible` when every phase around it is open. `applyPhases()` recomputes all of that, and `foldOf` (moment → the outermost closed phase holding it, i.e. the box that shows it), after any change to phases. Graphviz drops a node that is in a cluster and also in a `rank=same` set reaching outside it, so `dotSource()` keeps rank sets and order hints per cluster.

**Persistence.** `serialize()` / `loadGraph()` define the JSON file format (`format: "moment-dag", version: 1`; tasks have `time`, folds have `members`; older folds with `entry`/`exit` load through `foldRegion()`. Task-editor files with `start`/`end` still load, the moment taking the start or else the end). The same JSON is used for the localStorage autosave (`moment-dag-editor:v1`, kept apart from the task editor's `task-dag-editor:v1`), undo/redo snapshots (`restoreState` reloads with `keepView` so boxes slide), Save/Open files (File System Access API in Chrome/Edge, download otherwise), and share links (`#g=…`, compressed into the URL fragment). A new field must be added to both `serialize()` and `loadGraph()`, and `loadGraph()` must tolerate old files without it. Per-browser view preferences (legend, critical path, file name) live under separate `task-dag-editor:*` localStorage keys and are not part of the graph.

**Dialogs.** Use `askText` / `confirmAction` / `askDate` / `showLink`; they use SweetAlert2 and fall back to `prompt`/`confirm` if it didn't load. A capturing keydown handler keeps the editor's shortcuts out of open dialogs.

## Conventions

- User-visible features and keyboard shortcuts are documented in the help dialog in `index.html` (`#help`), and commits that add or change a feature update it in the same commit. Keep it in the same plain, concrete style.
- `Claude/FEATURES.md` is the list of feature ideas; mark items done there when implementing them.
- Code comments and UI text are short, plain English sentences explaining *why*; follow the existing tone.
- Commit messages: a short subject describing the user-visible behaviour (e.g. `"/" splits a task into two in a row`), then a paragraph explaining it.
