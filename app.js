/* Moment DAG editor — jQuery + Graphviz (viz.js). Each box is a moment: a
   single date (or date and time), with no duration. The code still calls them
   tasks internally (tasks, createTask…). */
$(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const ANIM_MS = 450;

  const $canvas = $('#canvas');
  const $world = $('#world');
  const $edgeLayer = $('#edges');
  const $input = $('#task-input');
  const $status = $('#status');
  const $empty = $('#empty');
  // Put the cursor back in the task field, but not on touch screens, where that
  // would pop up the on-screen keyboard.
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  // ---------------------------------------------------------------- dialogs
  // SweetAlert2 when it has loaded, the browser's own dialogs otherwise.
  const hasSwal = typeof window.Swal !== 'undefined';
  const dialog = hasSwal ? window.Swal.mixin({
    width: '26em',
    reverseButtons: true,             // Cancel on the left, the action on the right
    confirmButtonColor: '#0969da',
    cancelButtonColor: '#6e7781',
    returnFocus: true,
  }) : null;
  // While a dialog is open, the editor's own keys (Esc, !, undo…) stay out of it.
  // Registered first, so it runs before the other document key handlers.
  $(document).on('keydown', e => { if (hasSwal && window.Swal.isVisible()) e.stopImmediatePropagation(); });

  // Ask for a line of text; resolves to it, or null when cancelled.
  async function askText({ title, text = '', value = '', confirm = 'OK', selectName = false }) {
    if (!hasSwal) {
      const a = window.prompt(text ? `${title}\n${text}` : title, value);
      return a == null ? null : a;
    }
    const r = await dialog.fire({
      titleText: title, text, input: 'text', inputValue: value,
      inputAttributes: { autocomplete: 'off', spellcheck: 'false' },
      showCancelButton: true, confirmButtonText: confirm,
      inputValidator: v => v.trim() ? null : 'Please enter a name',
      didOpen: () => {   // select the name without its .json, ready to be typed over
        if (selectName) window.Swal.getInput().setSelectionRange(0, value.replace(/\.json$/i, '').length);
      },
    });
    return r.isConfirmed ? r.value : null;
  }
  // Ask before doing something; resolves to true to go ahead.
  async function confirmAction({ title, text = '', confirm = 'OK', danger = false }) {
    if (!hasSwal) return window.confirm(text ? `${title}\n\n${text}` : title);
    const r = await dialog.fire({
      titleText: title, text, icon: danger ? 'warning' : undefined,
      showCancelButton: true, confirmButtonText: confirm,
      confirmButtonColor: danger ? '#cf222e' : '#0969da',
    });
    return r.isConfirmed;
  }
  // Delete with arcs, or reconnect around: resolves to 'reconnect', 'arcs', or null.
  async function askDelete({ title, text }) {
    if (!hasSwal) {
      if (!window.confirm(`${title}\n\n${text}`)) return null;
      return window.confirm('Reconnect around them? (Cancel deletes their arcs too.)') ? 'reconnect' : 'arcs';
    }
    const r = await dialog.fire({
      titleText: title, text, icon: 'warning',
      showCancelButton: true, showDenyButton: true,
      confirmButtonText: 'Delete and reconnect', denyButtonText: 'Delete with arcs',
      confirmButtonColor: '#0969da', denyButtonColor: '#cf222e',
    });
    return r.isConfirmed ? 'reconnect' : r.isDenied ? 'arcs' : null;
  }
  // Ask for a date (days) or a date and time (hours); resolves to the value, or null.
  async function askDate({ title, text = '', value = '', confirm = 'OK' }) {
    if (!hasSwal) {
      const a = window.prompt(`${title}\n${text}\n(${hourMode ? 'YYYY-MM-DD HH:MM' : 'YYYY-MM-DD'})`, value.replace('T', ' '));
      return a == null ? null : a.trim();
    }
    const r = await dialog.fire({
      titleText: title, text, input: hourMode ? 'datetime-local' : 'date', inputValue: value,
      showCancelButton: true, confirmButtonText: confirm,
      inputValidator: v => parseTime(v) != null ? null : (hourMode ? 'Please pick a date and time' : 'Please pick a date'),
    });
    return r.isConfirmed ? r.value : null;
  }
  // Show a link to copy by hand (when the clipboard isn't available).
  async function showLink(url) {
    if (!hasSwal) { window.prompt('Copy this link:', url); return; }
    await dialog.fire({
      titleText: 'Copy this link', input: 'text', inputValue: url,
      inputAttributes: { readonly: 'readonly' }, confirmButtonText: 'Done',
      didOpen: () => window.Swal.getInput().select(),
    });
  }
  function focusInput() { if (finePointer) $input.trigger('focus'); }

  // ---------------------------------------------------------------- model
  const tasks = new Map();   // id -> {id, name, time, notes, locked, x, y, w, h, o, $el}
  let edges = [];            // {from, to, el}   (from's right connector -> to's left connector)
  let nextId = 1;
  let pending = null;        // {id, side: 'in'|'out'} — the selected (black) connector
  // Box order the user chose within a column (row, when vertical): pairs [a, b]
  // meaning a comes before b (above it; left of it when vertical).
  let orderHints = [];
  const rankOf = new Map();  // id -> rank (column/row) key from the last layout
  // Phases (folds): any set of moments the user grouped, plus every moment on
  // a path between two of them (so a folded phase never has arcs out and back in).
  // A closed phase is shown as one box; its moments stay in the model (dates,
  // conflicts, critical path) but are hidden. An open phase shows its moments,
  // kept together by graphviz (a cluster) inside a frame with the phase's name.
  const folds = new Map();   // id ('f1') -> {id, name, members: Set, open, start, end, x, y, w, h, cy, o, $el, $frame}
  const foldOf = new Map();  // task id -> id of the closed phase that hides it
  let nextFoldId = 1;
  let nameEdit = null;       // {el, name, save}: a moment's or phase's name being edited in place
  function nodeOf(id) { return foldOf.get(id) || id; }               // the box that shows a task
  function nodeObj(id) { return tasks.get(id) || folds.get(id); }
  function shownNodes() { return [...[...tasks.values()].filter(t => !foldOf.has(t.id)), ...[...folds.values()].filter(f => f.visible && !f.open)]; }
  // Phases nest: two phases either share no moments, or one holds all the
  // other's moments (and more). `contains(f, ms)`: phase f holds every moment of ms
  // and more besides, so a phase never contains itself.
  function contains(f, ms) { return f.members.size > ms.size && [...ms].every(id => f.members.has(id)); }
  // The moments a box stands for: a moment itself, or a phase's members.
  function membersOf(id) { const f = folds.get(id); return f ? f.members : new Set([id]); }
  // Why a phase with these moments can't be made (or kept) next to the others, or null.
  function nestProblem(ms, except = null) {
    for (const g of folds.values()) {
      if (g === except) continue;
      const shared = [...ms].filter(id => g.members.has(id)).length;
      if (!shared) continue;
      if (shared === ms.size && shared === g.members.size) return `That is already the phase “${g.name}”`;
      if (shared !== ms.size && shared !== g.members.size) return `That would cut across the phase “${g.name}”; a phase must hold all of another phase or none of it`;
    }
    return null;
  }
  function isInternal(e) { return foldOf.has(e.from) && foldOf.get(e.from) === foldOf.get(e.to); }
  // Arcs between boxes as shown: [from box, to box] (arcs inside a fold left out).
  function nodeEdges(all = false) {
    return edges.filter(e => !isInternal(e) && (all || !e.hidden)).map(e => [nodeOf(e.from), nodeOf(e.to)]);
  }

  // ---------------------------------------------------------------- view
  const view = { x: 0, y: 0, k: 1 };
  let userMoved = false;     // once the user pans/zooms we stop auto-fitting
  let initialView = false;   // next layout is a freshly loaded graph: show it like Fit does
  let vertical = false;      // layout direction: false = left to right, true = top to bottom
  let hourMode = false;      // time unit: false = whole days, true = date + time of day (minutes)
  let showDates = false;     // hour mode: the graph spans several dates, so boxes show the date too

  function setVertical(v) {
    vertical = v;
    $world.toggleClass('vertical', v);
    const icon = v
      ? '<path d="M8 2v11M4.5 9.5 8 13l3.5-3.5"/>'      // arrow down
      : '<path d="M2 8h11M9.5 4.5 13 8l-3.5 3.5"/>';    // arrow right
    $('#direction')
      .html(`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" ` +
            `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>` +
            `<span>${v ? 'Vertical' : 'Horizontal'}</span>`)
      .attr('title', v ? 'Switch to a left-to-right layout' : 'Switch to a top-to-bottom layout');
    $('#direction-menu').text(v ? 'Switch to horizontal layout' : 'Switch to vertical layout');
  }
  let tween = null;
  let layoutSeq = 0;
  const vizReady = Viz.instance();

  function applyView() {
    $world.css('transform', `translate(${view.x}px, ${view.y}px) scale(${view.k})`);
    const s = 24 * view.k;
    $canvas.css({
      'background-size': `${s}px ${s}px`,
      'background-position': `${view.x}px ${view.y}px`,
    });
    positionLegend();
  }

  // ---------------------------------------------------------------- time legend
  // The layout is by dependency order, not by date, so the legend labels each
  // column (or row, when vertical) with the weeks or months its tasks cover.
  const LEGEND_SIZE = 34;     // height of the band at the bottom (horizontal layout)
  const LEGEND_SIZE_V = 104;  // width of the band on the left (vertical layout)
  const $legend = $('#legend');
  const legend = { visible: false, ranks: [] };   // ranks: [{ids, $el}]

  // Whether to show the legend is a per-browser preference (not part of the graph). Off by default.
  const LEGEND_PREF_KEY = 'task-dag-editor:show-legend';
  let showLegend = false;
  try { showLegend = localStorage.getItem(LEGEND_PREF_KEY) === '1'; } catch (_) { /* storage unavailable */ }

  // ISO 8601 week number and its year for a day number (days since 1970-01-01).
  function isoWeek(day) {
    const d = new Date(day * DAY_MS);
    const dow = (d.getUTCDay() + 6) % 7;              // Monday = 0
    d.setUTCDate(d.getUTCDate() - dow + 3);           // Thursday of this week decides the year
    const year = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const week = 1 + Math.round(((d - jan4) / DAY_MS - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return { year, week };
  }

  // A box's time span in minutes, end exclusive (in day mode the day counts in
  // full): a moment is a single point, a folded group runs from its first to its last moment.
  function taskSpan(t) {
    const [a, b] = folds.has(t.id) ? [t.start, t.end] : [t.time, t.time];
    let s = parseTime(a) ?? parseTime(b);
    let e = parseTime(b) ?? parseTime(a);
    if (s == null) return null;
    if (e < s) [s, e] = [e, s];
    return hourMode ? { s, e } : { s: s * MIN_PER_DAY, e: (e + 1) * MIN_PER_DAY };
  }
  // First and last day a span touches.
  function spanDays(r) {
    const s = Math.floor(r.s / MIN_PER_DAY);
    return { s, e: r.e > r.s ? Math.ceil(r.e / MIN_PER_DAY) - 1 : s };
  }

  function fullDate(day) {
    const d = new Date(day * DAY_MS);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }

  function buildLegend(rankIds) {
    $legend.empty();
    const all = [...tasks.values()].map(taskSpan).filter(Boolean);
    legend.ranks = [];
    legend.rankIds = rankIds;
    legend.visible = showLegend && all.length > 0;
    $legend.toggleClass('vertical', vertical).prop('hidden', !legend.visible);
    $('body').toggleClass('legend-bottom', legend.visible && !vertical);
    if (!legend.visible) return;

    const minM = Math.min(...all.map(r => r.s)), maxM = Math.max(...all.map(r => r.e));
    const { s: min, e: max } = spanDays({ s: minM, e: maxM });
    let label;   // span in minutes -> {text, title}
    if (hourMode && min === max) {
      // Everything on one date: times of day.
      label = r => {
        const a = clockTime(r.s), b = clockTime(r.e);
        return { text: a === b ? a : `${a} – ${b}`, title: `${fullDate(min)}, ${a === b ? a : `${a} – ${b}`}` };
      };
    } else {
      const useDays = hourMode && max - min + 1 <= 31;   // a few days of hours: dates
      const useWeeks = !useDays && max - min + 1 <= 14 * 7;   // up to ~3 months: weeks, otherwise months
      const yearOf = day => new Date(day * DAY_MS).getUTCFullYear();
      const multiYear = useWeeks ? isoWeek(min).year !== isoWeek(max).year : yearOf(min) !== yearOf(max);
      const yy = y => multiYear ? ` ’${String(y).slice(2)}` : '';
      const unit = day => {
        const d = new Date(day * DAY_MS);
        if (useDays) return { key: day, text: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` };
        if (useWeeks) { const w = isoWeek(day); return { key: w.year * 100 + w.week, text: `W${w.week}${yy(w.year)}` }; }
        return { key: d.getUTCFullYear() * 12 + d.getUTCMonth(), text: MONTHS[d.getUTCMonth()] + yy(d.getUTCFullYear()) };
      };
      label = r => {
        const { s, e } = spanDays(r);
        const a = unit(s), b = unit(e);
        return { text: a.key === b.key ? a.text : `${a.text} – ${b.text}`,
                 title: s === e ? fullDate(s) : `${fullDate(s)} – ${fullDate(e)}` };
      };
    }

    rankIds.forEach(ids => {
      const spans = ids.map(id => taskSpan(nodeObj(id))).filter(Boolean);
      if (!spans.length) return;                      // no dated moment in this column
      const { text, title } = label({ s: Math.min(...spans.map(r => r.s)), e: Math.max(...spans.map(r => r.e)) });
      const $el = $('<div class="legend-label">').text(text).attr('title', title).appendTo($legend);
      legend.ranks.push({ ids, $el });
    });
    positionLegend();
  }

  // Place each label level with its column/row on screen (called on pan, zoom and animation).
  function positionLegend() {
    if (!legend.visible) return;
    const centres = legend.ranks.map(r => {
      let sum = 0;
      r.ids.forEach(id => {
        const t = nodeObj(id);
        sum += vertical ? t.y + t.h / 2 : t.x + t.w / 2;   // graphviz centres each rank
      });
      return (sum / r.ids.length) * view.k + (vertical ? view.y : view.x);
    });
    legend.ranks.forEach((r, i) => {
      // keep labels from running into their neighbours when zoomed out
      const gap = Math.min(
        i > 0 ? centres[i] - centres[i - 1] : Infinity,
        i < centres.length - 1 ? centres[i + 1] - centres[i] : Infinity);
      if (vertical) {
        r.$el.css({ top: centres[i], maxHeight: isFinite(gap) ? Math.max(0, gap - 4) : '' });
      } else {
        r.$el.css({ left: centres[i], maxWidth: isFinite(gap) ? Math.max(0, gap - 8) : '' });
      }
    });
  }

  // ---------------------------------------------------------------- status
  let statusTimer = null;
  // opts.action: {label, run} adds a button; the message then stays up longer.
  function showStatus(msg, opts = {}) {
    clearTimeout(statusTimer);
    $status.text(msg).toggleClass('error', !!opts.error).toggleClass('has-action', !!opts.action).addClass('show');
    if (opts.action) {
      $('<button type="button">').text(opts.action.label)
        .on('click', () => { hideStatus(); opts.action.run(); }).appendTo($status);
    }
    if (!opts.sticky) statusTimer = setTimeout(hideStatus, opts.action ? 10000 : 2500);
  }
  function hideStatus() { clearTimeout(statusTimer); $status.removeClass('show has-action'); }

  // ---------------------------------------------------------------- tasks
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "09:30" for a minute number.
  function clockTime(min) { return new Date(min * 60000).toISOString().slice(11, 16); }
  function shortDate(day) { const d = new Date(day * DAY_MS); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; }

  // A time in words: "Jul 1" (days), "Jul 1 09:30" (hours).
  function displayValue(value) {
    const n = parseTime(value);
    if (n == null) return String(value);
    return hourMode ? `${shortDate(Math.floor(n / MIN_PER_DAY))} ${clockTime(n)}` : shortDate(n);
  }
  // How a time shows in a box: the date (days), or the time of day with the
  // date underneath when the graph spans more than one date (hours).
  function formatTimeField(value) {
    const n = parseTime(value);
    if (n == null) return { short: String(value), long: String(value) };
    if (!hourMode) return { short: shortDate(n), long: fullDate(n) };
    const day = Math.floor(n / MIN_PER_DAY);
    return { short: clockTime(n), sub: showDates ? shortDate(day) : null, long: `${fullDate(day)}, ${clockTime(n)}` };
  }

  // Lengths of time (waits, slack). Days: shown as "5d", "3w", "3w 1d". Hours:
  // minutes, shown as "45m", "2h 30m", "1d 4h". Spelled out in the tooltip.
  function formatDuration(value) {
    const n = parseDuration(value);
    if (n == null) return { short: String(value), long: String(value) };
    const plural = (k, unit) => `${k} ${unit}${k === 1 ? '' : 's'}`;
    if (hourMode) {
      const d = Math.floor(n / MIN_PER_DAY), h = Math.floor(n % MIN_PER_DAY / 60), m = n % 60;
      const short = d ? (h ? `${d}d ${h}h` : `${d}d`) : h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
      const long = [d && plural(d, 'day'), h && plural(h, 'hour'), m && plural(m, 'minute')].filter(Boolean).join(' ') || '0 minutes';
      return { short, long };
    }
    const w = Math.floor(n / 7), d = n % 7;
    const short = w === 0 ? `${d}d` : d === 0 ? `${w}w` : `${w}w ${d}d`;
    const long = plural(n, 'day') + (w > 0 ? ` (${[w && plural(w, 'week'), d && plural(d, 'day')].filter(Boolean).join(' ')})` : '');
    return { short, long };
  }
  // Exact length for a wait field: days as a number, hours as "1d 2h 30m".
  function durationInput(n) {
    if (!hourMode) return n;
    const d = Math.floor(n / MIN_PER_DAY), h = Math.floor(n % MIN_PER_DAY / 60), m = n % 60;
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
  }

  function field(label, value, format) {
    const undef = value == null || value === '';
    const f = undef ? null : format(value);
    return $('<div class="field">').append(
      $('<dt>').text(label),
      $('<dd>').toggleClass('undef', undef)
        .text(undef ? '—' : f.short)
        .append(!undef && f.sub ? $('<span class="sub">').text(f.sub) : null)
        .attr('title', undef ? 'Not set' : f.long)
    );
  }

  function addTask(name) {
    const id = 't' + nextId++;
    createTask({ id, name });
    focusId = id;   // bring the new box into view
    if (pending) refreshConnectors();
    changed();
  }

  const NOTE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M3 1.5h7l3 3v10H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M5.5 7.5h5M5.5 10h5M5.5 12.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  const LOCK_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/>' +
    '<path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  // A moment that has its time set.
  function isDated(t) { return !!t.time; }
  function timeLabel() { return hourMode ? 'Time' : 'Date'; }

  // (Re)draw a box's contents and re-measure it (the name may wrap differently).
  function renderTask(t) {
    if (nameEdit && t.$el[0].contains(nameEdit.el)) return;   // being renamed in its box; redrawn when done
    const hasNotes = !!(t.notes && t.notes.trim());
    t.$el.find('.name').text(t.name)
      .append(t.locked ? $('<span class="lock-icon" aria-label="Locked" title="Locked: never moved automatically">').html(LOCK_ICON) : null)
      .append(hasNotes ? $('<span class="note-icon" aria-label="Has notes">').html(NOTE_ICON) : null)
      .attr('title', hasNotes ? t.notes : null);
    t.$el.toggleClass('dated', isDated(t));   // thicker border; changes the size, so before measuring
    t.$el.find('.fields').empty().append(field(timeLabel(), t.time, formatTimeField));
    t.w = t.$el.outerWidth();
    t.h = t.$el.outerHeight();
    // Connectors (and arc ends) sit on the divider under the name, whose
    // height depends on how the name wraps.
    const border = parseFloat(t.$el.css('border-top-width')) || 0;
    const nameEl = t.$el.find('.name')[0];
    const dividerY = nameEl.offsetHeight - 0.5;            // centre of the 1px divider, inside the border
    t.$el[0].style.setProperty('--divider', dividerY + 'px');   // used by the horizontal layout's CSS
    t.cy = border + dividerY;                              // same point, from the box's outer top
  }

  function createTask({ id, name, time = null, notes = '', locked = false }) {
    const t = { id, name, time: typeof time === 'string' && time ? time : null, notes: typeof notes === 'string' ? notes : '', locked: locked === true, x: 0, y: 0, o: 0 };
    t.$el = $('<div class="task">').attr('data-id', id).append(
      $('<div class="conn conn-in" title="Click, then pick a green connector to connect">'),
      $('<div class="name">'),
      $('<dl class="fields">'),
      $('<div class="conn conn-out" title="Click, then pick a green connector to connect">')
    ).css({ opacity: 0 }).appendTo($world);
    renderTask(t);
    t.fresh = true;
    tasks.set(id, t);
    $empty.hide();
    return t;
  }

  // ---------------------------------------------------------------- edges
  function descendants(id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of edges) {
        if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
      }
    }
    return seen;
  }

  // Can we add from -> to without duplicating an edge or creating a cycle?
  function edgeProblem(from, to) {
    if (from === to) return 'A moment cannot come after itself';
    if (edges.some(e => e.from === from && e.to === to)) return 'Those moments are already connected';
    if (descendants(to).has(from)) return 'That connection would create a cycle';
    return null;
  }

  function addEdge(from, to, wait = null) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'edge');
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = 'Click to set a wait or remove the arc';
    const hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('class', 'hit');
    const line = document.createElementNS(SVGNS, 'path');
    line.setAttribute('class', 'line');
    line.setAttribute('marker-end', 'url(#arrow)');
    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('class', 'wait-label');
    g.append(title, hit, line, label);
    $edgeLayer[0].appendChild(g);
    const e = { from, to, el: g, wait };
    edges.push(e);
    drawEdge(e);
    return e;
  }

  function removeEdge(e) {
    edges = edges.filter(x => x !== e);
    e.el.remove();
    if (pending) refreshConnectors();
    changed();
  }

  // Arc from a's outgoing connector to b's incoming one. It leaves and arrives
  // with short straight pieces, so the arrowhead (about 16px long) always sits
  // on a straight part of the line and points along it; the bend happens in between.
  const ARC_LEAD = 10;   // straight piece after the outgoing connector
  const ARC_TAIL = 20;   // straight piece before the incoming connector, longer than the arrowhead
  const ARROW_GAP = 8;   // the arrow tip stops just outside the connector circle

  function edgePath(a, b) {
    // Work in (along, across) coordinates: along = direction of the flow.
    let s, e, P;
    if (vertical) {   // bottom connector -> top connector
      s = { u: a.y + a.h, v: a.x + a.w / 2 };
      e = { u: b.y - ARROW_GAP, v: b.x + b.w / 2 };
      P = (u, v) => `${v},${u}`;
    } else {          // right connector -> left connector, level with the divider
      s = { u: a.x + a.w, v: a.y + a.cy };
      e = { u: b.x - ARROW_GAP, v: b.y + b.cy };
      P = (u, v) => `${u},${v}`;
    }
    const u1 = s.u + ARC_LEAD, u2 = e.u - ARC_TAIL;
    const bend = Math.max(vertical ? 24 : 32, Math.abs(u2 - u1) / 2);
    return `M${P(s.u, s.v)} L${P(u1, s.v)} ` +
           `C${P(u1 + bend, s.v)} ${P(u2 - bend, e.v)} ${P(u2, e.v)} ` +
           `L${P(e.u, e.v)}`;
  }

  // Graphviz's route for an arc (cubic bézier points, world coordinates), which
  // goes around boxes. Valid only while the boxes are where graphviz put them;
  // during animations and drags the simple curve above is used instead.
  let splinesOn = false;
  let freeMoving = null;   // id of a box being dragged or sliding back: its arcs use simple curves
  function splinePath({ pts, tip }) {
    let path = `M${pts[0]}`;
    for (let i = 1; i + 2 < pts.length; i += 3) path += ` C${pts[i]} ${pts[i + 1]} ${pts[i + 2]}`;
    const last = pts[pts.length - 1];
    if (!tip) return path;
    // Straight on from where graphviz's route stops (the base of its arrowhead)
    // towards the head connector, ending the gap short of it.
    const dx = tip[0] - last[0], dy = tip[1] - last[1], len = Math.hypot(dx, dy) || 1;
    return path + ` L${[tip[0] - dx / len * ARROW_GAP, tip[1] - dy / len * ARROW_GAP]}`;
  }

  function drawEdge(e) {
    const a = nodeOf(e.from), b = nodeOf(e.to);
    const useSpline = splinesOn && e.spline && freeMoving !== a && freeMoving !== b;
    const d = useSpline ? splinePath(e.spline) : edgePath(nodeObj(a), nodeObj(b));
    for (const p of e.el.querySelectorAll('path')) p.setAttribute('d', d);
    // An arc with its own wait shows it halfway along.
    const label = e.el.querySelector('.wait-label');
    if (e.wait != null) {
      const line = e.el.querySelector('.line'), at = line.getPointAtLength(line.getTotalLength() / 2);
      label.setAttribute('x', at.x);
      label.setAttribute('y', at.y - 6);
      label.textContent = '+' + waitText(parseDuration(e.wait) ?? 0);
    } else if (label.textContent) {
      label.textContent = '';
    }
  }
  function drawEdges() { edges.forEach(e => { if (!e.hidden) drawEdge(e); }); drawFrames(); }

  // Transitive reduction for display: an edge A -> C is hidden when C can also
  // be reached from A through some other successor (e.g. A -> B -> C). Hidden
  // edges stay in the model, so they reappear if the longer path is removed.
  function isTransitive(e) {
    return edges.some(o => o !== e && o.from === e.from && descendants(o.to).has(e.to));
  }

  // ---------------------------------------------------------------- date conflicts
  const DAY_MS = 86400000;
  function parseDate(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v == null ? '' : String(v).trim());
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS : null;   // whole days
  }
  function parseDays(v) {
    const m = /^(\d+)\s*d?$/i.exec(v == null ? '' : String(v).trim());
    return m ? +m[1] : null;
  }

  // Hour mode works in minutes since 1970: "2026-11-15T09:30" (a bare date is midnight).
  const MIN_PER_DAY = 1440;
  function parseDateTime(v) {
    // Seconds (some browsers' date-time fields include them) are accepted and ignored.
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(v == null ? '' : String(v).trim());
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) / 60000 : null;
  }
  function isoFromMinute(n) { return new Date(n * 60000).toISOString().slice(0, 16); }
  // Hour-mode durations: "150m", "2h 30m", "1d 4h", "1.5h", "1:30"; a bare number is hours.
  function parseMinutes(v) {
    const str = v == null ? '' : String(v).trim().toLowerCase();
    if (!str) return null;
    let m = /^(\d+):([0-5]\d)$/.exec(str);
    if (m) return +m[1] * 60 + +m[2];
    if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 60);
    m = /^(?:(\d+(?:\.\d+)?)\s*d(?:ays?)?)?\s*(?:(\d+(?:\.\d+)?)\s*h(?:(?:ou)?rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(str);
    if (!m || !(m[1] || m[2] || m[3])) return null;
    return Math.round((+(m[1] || 0)) * MIN_PER_DAY + (+(m[2] || 0)) * 60 + (+(m[3] || 0)));
  }

  // The current time unit: days, or minutes in hour mode.
  function parseTime(v) { return hourMode ? parseDateTime(v) : parseDate(v); }
  function formatTime(n) { return hourMode ? isoFromMinute(n) : isoFromDay(n); }
  function parseDuration(v) { return hourMode ? parseMinutes(v) : parseDays(v); }
  function durationValue(n) { return hourMode ? `${n}m` : `${n}d`; }
  // Wait between moments, in the current unit: an arc's own (e.wait, e.g. "2d"
  // or "240m"), or else the graph's. A moment may come at the earliest at the
  // moment before it + wait; without a wait, at the same time (or on the same day).
  let graphWait = null;   // "1d", "15m", or null for none
  function waitOf(e) { return (e.wait != null ? parseDuration(e.wait) : null) ?? parseDuration(graphWait) ?? 0; }
  function minGap(e) { return waitOf(e); }
  function waitText(n) { return formatDuration(durationValue(n)).short; }

  // A moment is in conflict when it is connected to a moment whose time
  // violates the dependency: the later moment comes before the earlier one
  // (or before the wait between them is over).
  function updateConflicts() {
    const problems = new Map();
    tasks.forEach((t, id) => problems.set(id, []));

    edges.forEach(edge => {
      const a = tasks.get(edge.from), b = tasks.get(edge.to);
      const aT = parseTime(a.time), bT = parseTime(b.time);
      edge.conflict = aT != null && bT != null && bT < aT + minGap(edge);
      edge.el.classList.toggle('conflict', edge.conflict);
      edge.el.querySelector('.line').setAttribute('marker-end', edge.conflict ? 'url(#arrow-conflict)' : 'url(#arrow)');
      if (edge.conflict) {
        const at = displayValue(a.time), bt = displayValue(b.time);
        const w = waitOf(edge);
        if (w > 0 && bT >= aT) {   // only the wait is missing
          problems.get(b.id).push(`Too soon after “${a.name}” (${at}, then a ${waitText(w)} wait)`);
          problems.get(a.id).push(`Too late for “${b.name}” (${bt}, after a ${waitText(w)} wait)`);
        } else {
          problems.get(b.id).push(`Comes before “${a.name}” (${at})`);
          problems.get(a.id).push(`Comes after “${b.name}” (${bt})`);
        }
      }
    });

    tasks.forEach((t, id) => {
      const list = problems.get(id);
      t.problems = list;
      t.$el.toggleClass('conflict', list.length > 0)
        .attr('title', list.length ? 'Date conflict:\n• ' + list.join('\n• ') : null);
    });
    folds.forEach(f => {
      const bad = [...f.members].filter(id => tasks.get(id).problems.length);
      f.$el.toggleClass('conflict', bad.length > 0).attr('title', 'A phase: the moments from its first to its last, folded into one box. Click to unfold it.' +
        (bad.length ? '\n\nDate conflict in ' + bad.map(id => `“${tasks.get(id).name}”`).join(', ') : ''));
    });
  }

  // ---------------------------------------------------------------- critical path
  // A per-browser view setting (like the legend), toggled with "!" or in the menu.
  const CRITICAL_PREF_KEY = 'task-dag-editor:show-critical';
  let showCritical = false;
  try { showCritical = localStorage.getItem(CRITICAL_PREF_KEY) === '1'; } catch (_) { /* storage unavailable */ }

  function topoOrder() {
    const indeg = new Map([...tasks.keys()].map(id => [id, 0]));
    edges.forEach(e => indeg.set(e.to, indeg.get(e.to) + 1));
    const queue = [...indeg].filter(([, n]) => n === 0).map(([id]) => id), order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      edges.forEach(e => {
        if (e.from !== id) return;
        indeg.set(e.to, indeg.get(e.to) - 1);
        if (indeg.get(e.to) === 0) queue.push(e.to);
      });
    }
    return order;
  }

  // Slack (total float): how much later a moment could be before it pushes a
  // moment that comes after it, or the last moment of the whole plan. A moment
  // without a time counts as early as the moments before it allow.
  // Returns { times: id -> {s, e, latestEnd, slack}, latestStart: id -> time }
  // for the moments whose times can be worked out (s and e are the same time).
  function computeSlack() {
    const order = topoOrder();
    const times = new Map(), latestStart = new Map();
    order.forEach(id => {
      let s = parseTime(tasks.get(id).time);
      if (s == null) {
        const ends = edges.filter(x => x.to === id && times.has(x.from)).map(x => times.get(x.from).e + minGap(x));
        if (ends.length) s = Math.max(...ends);
      }
      if (s != null) times.set(id, { s, e: s });
    });
    if (!times.size) return { times, latestStart };
    const finish = Math.max(...[...times.values()].map(r => r.e));
    [...order].reverse().forEach(id => {
      const r = times.get(id);
      const after = edges.filter(x => x.from === id && latestStart.has(x.to)).map(x => latestStart.get(x.to) - minGap(x));
      const lf = after.length ? Math.min(...after) : r ? finish : null;
      if (r) {
        r.latestEnd = lf;
        r.slack = lf - r.e;
        latestStart.set(id, lf - (r.e - r.s));
      } else if (lf != null) {
        latestStart.set(id, lf);   // time unknown: pass the constraint on to the moments before it
      }
    });
    return { times, latestStart };
  }

  function slackText(r) {
    const long = formatDuration(durationValue(Math.abs(r.slack))).long;
    const by = displayValue(formatTime(r.latestEnd));
    if (r.slack === 0) return 'Critical: any delay here delays what comes after it.';
    if (r.slack > 0) return `Slack: ${long}. It can be as late as ${by} without delaying anything.`;
    return `Behind by ${long}: it would have to be by ${by} for the later dates to hold.`;
  }

  function updateCritical() {
    const { times, latestStart } = showCritical ? computeSlack() : { times: new Map(), latestStart: new Map() };
    tasks.forEach((t, id) => {
      const r = times.get(id) || null;
      t.slack = r;
      t.$el.toggleClass('critical', !!r && r.slack <= 0);
      t.$el.children('.slack').remove();
      if (r && r.slack !== 0) {
        const f = formatDuration(durationValue(Math.abs(r.slack))).short;
        $('<span class="slack">').toggleClass('behind', r.slack < 0)
          .text((r.slack < 0 ? '−' : '+') + f).attr('title', slackText(r)).appendTo(t.$el);
      }
    });
    folds.forEach(f => {
      const rs = [...f.members].map(id => times.get(id)).filter(Boolean);
      const least = rs.length ? Math.min(...rs.map(r => r.slack)) : null;
      f.$el.toggleClass('critical', least != null && least <= 0);
      f.$el.children('.slack').remove();
      if (least != null && least !== 0) {
        const fmt = formatDuration(durationValue(Math.abs(least))).short;
        $('<span class="slack">').toggleClass('behind', least < 0).text((least < 0 ? '−' : '+') + fmt).appendTo(f.$el);
      }
    });
    edges.forEach(e => {
      const a = times.get(e.from), b = times.get(e.to);
      // The arc that sets the latest time of a critical moment.
      e.critical = !!(a && b && a.slack <= 0 && b.slack <= 0 && latestStart.get(e.to) - minGap(e) === a.latestEnd);
      e.el.classList.toggle('critical', e.critical);
      e.el.querySelector('.line').setAttribute('marker-end',
        e.conflict ? 'url(#arrow-conflict)' : e.critical ? 'url(#arrow-critical)' : 'url(#arrow)');
    });
  }

  function setShowCritical(v) {
    showCritical = v;
    $('#critical-toggle').attr('aria-checked', String(v));
    try { localStorage.setItem(CRITICAL_PREF_KEY, v ? '1' : '0'); } catch (_) { /* storage unavailable */ }
    updateCritical();
    if (selectedId) fillProps();
    showStatus(v ? 'Critical path shown' : 'Critical path hidden');
  }

  function updateHiddenEdges() {
    edges.forEach(e => {
      // An arc with its own wait always shows; arcs inside a folded group never do.
      e.hidden = isInternal(e) || (e.wait == null && isTransitive(e));
      e.el.style.display = e.hidden ? 'none' : '';
    });
  }


  // ---------------------------------------------------------------- folded groups
  function ancestors(id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of edges) {
        if (e.to === cur && !seen.has(e.from)) { seen.add(e.from); stack.push(e.from); }
      }
    }
    return seen;
  }

  // Old files store a phase as its first and last moment: the moments on the
  // paths from a to b (in either order), if arcs from outside only go to the
  // first and arcs to the outside only leave from the last. Returns {members} or {error}.
  function foldRegion(a, b) {
    const A = tasks.get(a), B = tasks.get(b);
    if (!A || !B || a === b) return { error: 'Pick two different moments' };
    let down = descendants(a);
    if (!down.has(b)) {
      if (!descendants(b).has(a)) return { error: `“${A.name}” and “${B.name}” aren’t connected by a path of arcs` };
      [a, b] = [b, a];
      down = descendants(a);
    }
    const up = ancestors(b);
    const members = new Set([...down].filter(id => up.has(id)));
    const name = id => `“${tasks.get(id).name}”`;
    for (const e of edges) {
      const inFrom = members.has(e.from), inTo = members.has(e.to);
      if (inTo && !inFrom && e.to !== a) {
        return { error: `${name(e.to)} also depends on ${name(e.from)}, outside the phase. Only ${name(a)} may have arcs coming in.` };
      }
      if (inFrom && !inTo && e.from !== b) {
        return { error: `${name(e.to)}, outside the phase, depends on ${name(e.from)}. Only ${name(b)} may have arcs going out.` };
      }
    }
    return { members };
  }

  // Moments that lie on a path from one moment of ms to another but aren't in ms.
  function between(ms) {
    const reach = (dir) => {
      const seen = new Set(), stack = [...ms];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of edges) {
          const [a, b] = dir ? [e.from, e.to] : [e.to, e.from];
          if (a === cur && !seen.has(b)) { seen.add(b); stack.push(b); }
        }
      }
      return seen;
    };
    const down = reach(true), up = reach(false);
    return new Set([...down].filter(id => up.has(id) && !ms.has(id)));
  }
  // A phase's first moments (no arc in from inside it) and last ones (no arc out to inside it).
  function phaseSources(ms) { return [...ms].filter(id => !edges.some(e => e.to === id && ms.has(e.from))); }
  function phaseSinks(ms) { return [...ms].filter(id => !edges.some(e => e.from === id && ms.has(e.to))); }
  // The earliest of the first moments (by time, then the order they were made), and the latest of the last.
  function byTime(ids) {
    return [...ids].sort((a, b) => (parseTime(tasks.get(a).time) ?? Infinity) - (parseTime(tasks.get(b).time) ?? Infinity) ||
      parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  }
  function firstMember(ms) { return byTime(phaseSources(ms))[0]; }
  function lastMember(ms) { const s = byTime(phaseSinks(ms)); return s[s.length - 1]; }
  function defaultPhaseName(ms) {
    const a = tasks.get(firstMember(ms)).name, b = tasks.get(lastMember(ms)).name;
    return a === b ? a : `${a} … ${b}`;
  }

  function createFold({ id, name, members, open = false }) {
    const f = { id, name: name || defaultPhaseName(members), members, open, x: 0, y: 0, o: 0, visible: true };
    f.$el = $('<div class="task fold">').attr('data-id', id)
      .attr('title', 'A phase: moments folded into one box. Click to open it.').append(
        $('<div class="conn conn-in" title="Click, then pick a green connector: the whole phase comes after that moment">'),
        $('<div class="name">'),
        $('<dl class="fields">'),
        $('<div class="conn conn-out" title="Click, then pick a green connector: the whole phase comes before that moment">')
      ).css({ opacity: 0 }).appendTo($world);
    // The frame around the moments of the open phase, behind the arcs and boxes.
    // Its label: ▾ folds the phase, double-clicking the name renames it, × removes it.
    f.$frame = $('<div class="phase-frame" hidden>').attr('data-phase', id).append(
      $('<div class="phase-label">').append(
        $('<button type="button" class="phase-fold" title="Fold the phase into one box" aria-label="Fold the phase">▾</button>'),
        $('<span class="phase-name" title="Double-click to rename the phase">'),
        $('<button type="button" class="phase-remove" title="Remove the phase (the moments stay)" aria-label="Remove the phase">×</button>'))
    ).prependTo($world);
    // Fade in where the box showing the phase's first moment was.
    const at = nodeObj(nodeOf(firstMember(members)));
    Object.assign(f, { x: at.x, y: at.y });
    f.$el.css({ left: at.x, top: at.y });
    folds.set(id, f);
    applyPhases();
    return f;
  }

  // Work out what is shown, from which phases are open: a phase is visible when
  // every phase around it is open; a visible closed phase is one box, and hides
  // everything inside it; a visible open phase gets a frame. Then redraw the phases.
  function applyPhases() {
    const list = [...folds.values()];
    list.forEach(f => {
      f.visible = !list.some(g => !g.open && contains(g, f.members));
      f.$el.css('display', f.visible && !f.open ? '' : 'none');
      f.$frame.prop('hidden', !(f.visible && f.open));
    });
    foldOf.clear();
    tasks.forEach((t, id) => {
      // shown as the outermost closed phase that holds it
      const closed = list.filter(f => !f.open && f.members.has(id)).sort((a, b) => b.members.size - a.members.size)[0];
      if (closed) foldOf.set(id, closed.id);
      t.$el.toggleClass('folded', !!closed).toggleClass('in-phase', list.some(f => f.members.has(id)));
    });
    // Bigger phases first in the page, so the frames of phases inside them are drawn on top.
    // (Only when the order changes: moving a frame would end a rename in progress.)
    const order = [...list].sort((a, b) => b.members.size - a.members.size);
    const now = $world.children('.phase-frame').get();
    if (order.some((f, i) => f.$frame[0] !== now[i])) [...order].reverse().forEach(f => f.$frame.prependTo($world));
    list.forEach(renderFold);
  }

  // Boxes that newly appear (when a phase opens or goes away) come out of where it was.
  function emergeFrom(before, x, y) {
    shownNodes().forEach(n => {
      if (before.has(n.id)) return;
      Object.assign(n, { x, y, o: 0, fresh: false });
      n.$el.css({ left: x, top: y, opacity: 0 });
    });
  }
  function shownIds() { return new Set(shownNodes().map(n => n.id)); }

  // A fold of moments is a phase. Box contents: the name, how many moments, and
  // when it starts and ends (its earliest and latest moment).
  function renderFold(f) {
    const ts = [...f.members].map(id => tasks.get(id));
    const times = ts.map(t => parseTime(t.time)).filter(v => v != null);
    f.start = times.length ? formatTime(Math.min(...times)) : null;
    f.end = times.length ? formatTime(Math.max(...times)) : null;
    f.$el.toggleClass('dated', !!(f.start && f.end));
    if (!nameEdit || !f.$el[0].contains(nameEdit.el)) {   // not while it's being renamed in its box
      f.$el.find('.name').empty().append(
        $('<span class="fold-mark" aria-hidden="true">▸</span>'),
        document.createTextNode(f.name),
        $('<span class="fold-count">').text(`Phase · ${ts.length} moments`));
    }
    f.$el.find('.fields').empty().append(
      field('Start', f.start, formatTimeField),
      field('End', f.end, formatTimeField));
    const nameEl = f.$frame.find('.phase-name')[0];
    if (!nameEdit || nameEdit.el !== nameEl) nameEl.textContent = f.name;
    if (f.visible && !f.open) {   // a hidden box has no size to measure
      f.w = f.$el.outerWidth();
      f.h = f.$el.outerHeight();
      const border = parseFloat(f.$el.css('border-top-width')) || 0;
      const dividerY = f.$el.find('.name')[0].offsetHeight - 0.5;
      f.$el[0].style.setProperty('--divider', dividerY + 'px');
      f.cy = border + dividerY;
    }
  }

  // Frames of the open phases, around the boxes shown inside them and the
  // frames of open phases inside them (called with the arcs, so they follow
  // animations and drags). Graphviz leaves a margin around each cluster, room
  // for the frame and its name.
  const FRAME_PAD = 10, FRAME_LABEL = 24;
  function drawFrames() {
    const open = [...folds.values()].filter(f => f.open && f.visible).sort((a, b) => a.members.size - b.members.size);
    const shown = shownNodes();
    open.forEach(f => {   // inner phases first
      const rects = shown.filter(n => contains(f, membersOf(n.id))).map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h, o: n.o }));
      open.forEach(g => { if (g.frame && contains(f, g.members)) rects.push(g.frame); });
      if (!rects.length) return;
      const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
      const x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h));
      f.frame = { x: x0 - FRAME_PAD, y: y0 - FRAME_PAD - FRAME_LABEL,
                  w: x1 - x0 + 2 * FRAME_PAD, h: y1 - y0 + 2 * FRAME_PAD + FRAME_LABEL,
                  o: Math.min(...rects.map(r => r.o)) };
      f.$frame.css({ left: f.frame.x, top: f.frame.y, width: f.frame.w, height: f.frame.h, opacity: f.frame.o });
    });
    open.forEach(f => { delete f.frame; });
  }

  // Remove a phase; its moments (and any phases inside it) stay. A closed
  // phase's contents come out of its box.
  function dropFold(f) {
    const before = shownIds();
    folds.delete(f.id);
    f.$el.remove();
    f.$frame.remove();
    applyPhases();
    if (!f.open && f.visible) emergeFrom(before, f.x, f.y);
  }

  // Before every layout: deleted moments leave their phases, and a phase takes
  // in any moment that a new arc put between two of its moments. A phase left
  // empty, or that now cuts across another phase, is removed.
  function refreshFolds() {
    folds.forEach(f => {
      const ms = new Set([...f.members].filter(id => tasks.has(id)));
      if (!ms.size) { dropFold(f); return; }
      between(ms).forEach(id => ms.add(id));
      f.members = ms;
    });
    folds.forEach(f => { if (folds.has(f.id) && nestProblem(f.members, f)) dropFold(f); });
    applyPhases();
  }

  // Open a closed phase: what's inside comes out of the box, in a frame. The
  // phases inside it show as they were left, folded or open.
  function expandFold(id, opts = {}) {
    const f = folds.get(id);
    if (!f || f.open) return;
    if (pending) cancelPending();
    const before = shownIds();
    f.open = true;
    applyPhases();
    emergeFrom(before, f.x, f.y);
    changed();
    if (!opts.quiet) showStatus(`Opened the phase “${f.name}”. Click ▾ to fold it again; double-click its name to rename it.`);
  }

  // A name being typed in a phase's frame is saved first.
  function commitPhaseName(f) {
    if (nameEdit && f.$frame[0].contains(nameEdit.el)) endNameEdit(true);
  }

  // Fold an open phase back into one box, where its first moment is shown.
  function foldPhase(id) {
    const f = folds.get(id);
    if (!f || !f.open) return;
    commitPhaseName(f);
    if (pending) cancelPending();
    if (selectedId && f.members.has(selectedId)) closeProps();
    const at = nodeObj(nodeOf(firstMember(f.members)));
    f.open = false;
    Object.assign(f, { x: at.x, y: at.y, o: 0 });
    f.$el.css({ left: at.x, top: at.y, opacity: 0 });
    applyPhases();
    changed();
  }

  function removePhase(id) {
    const f = folds.get(id);
    if (!f) return;
    commitPhaseName(f);
    if (pending) cancelPending();
    dropFold(f);
    changed();
    showStatus(`Removed the phase “${f.name}”; what was in it stays`, { action: { label: 'Undo', run: undo } });
  }

  // Group the picked boxes into a new, folded phase, with any moments that lie
  // between them, then let the user type its name in the box.
  function groupPicked() {
    if (picked.size < 2) { showStatus('Pick two or more boxes to group into a phase', { error: true }); return; }
    const ms = new Set();
    picked.forEach(id => membersOf(id).forEach(m => ms.add(m)));
    const extra = between(ms);
    extra.forEach(id => ms.add(id));
    const problem = nestProblem(ms);
    if (problem) { showStatus(problem, { error: true }); return; }
    clearPicks();
    closeProps();
    if (pending) cancelPending();
    const f = createFold({ id: 'f' + nextFoldId++, members: ms });
    changed();
    showStatus(`Made a phase of ${ms.size} moments` +
      (extra.size ? `, with ${extra.size === 1 ? `“${tasks.get([...extra][0]).name}”, which lies` : `${extra.size} moments that lie`} between them` : '') +
      '. Type its name, then Enter.');
    startNameEdit(f.$el.find('.name')[0], f.name, phaseNameSaver(f));
  }

  // ---------------------------------------------------------------- picking boxes
  // Boxes picked to be grouped into a phase: Shift- (or ⌘/Ctrl-) click with a
  // mouse; on a touch screen, press and hold a box, then tap more. While any box
  // is picked a bar at the bottom offers "Group to phase".
  const picked = new Set();   // ids of shown boxes (moments or folded phases)
  const $pickbar = $('#pickbar');
  function togglePick(id) {
    if (pending) cancelPending();
    if (!picked.size && selectedId && selectedId !== id && !foldOf.has(selectedId)) picked.add(selectedId);   // the moment shown in the panel
    closeProps();
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    showPicks();
  }
  function clearPicks() { picked.clear(); showPicks(); }
  function showPicks() {
    const shown = shownIds();
    [...picked].forEach(id => { if (!shown.has(id)) picked.delete(id); });   // folded away, or deleted
    $world.find('.task.picked').removeClass('picked');
    picked.forEach(id => nodeObj(id).$el.addClass('picked'));
    const n = picked.size;
    $pickbar.prop('hidden', !n);
    $('body').toggleClass('picking', n > 0);
    $pickbar.find('.pick-count').text(n === 1 ? '1 box picked, pick more' : `${n} boxes picked`);
    $('#pick-group').prop('disabled', n < 2);
    $('#pick-delete').attr('title', n === 1 ? 'Delete the picked box (Delete)' : 'Delete the picked boxes (Delete)');
  }
  $('#pick-group').on('click', groupPicked);
  $('#pick-cancel').on('click', clearPicks);
  $('#pick-delete').on('click', () => deleteBoxes([...picked]));
  $(document).on('keydown', e => { if (e.key === 'Escape' && picked.size && $help.prop('hidden')) clearPicks(); });

  // ---------------------------------------------------------------- connecting
  // The edge that would be created by clicking the green connector on task `otherId`.
  function candidateEdge(otherId) {
    return pending.side === 'in'
      ? { from: otherId, to: pending.id }
      : { from: pending.id, to: otherId };
  }

  // The task a box's connector stands for: a folded phase's incoming connector
  // is its first moment's, its outgoing one its last moment's.
  function connTask(nodeId, side) {
    const f = folds.get(nodeId);
    return f ? (side === 'in' ? firstMember(f.members) : lastMember(f.members)) : nodeId;
  }
  // The arcs [from, to] that connecting two boxes makes: an arc to a folded phase
  // goes to each of its first moments, one from it leaves from each of its last
  // ones, so the whole phase comes after (or before) the other box.
  function boxArcs(from, to) {
    const f = folds.get(nodeOf(from)), g = folds.get(nodeOf(to));
    const froms = f ? phaseSinks(f.members) : [from], tos = g ? phaseSources(g.members) : [to];
    return froms.flatMap(a => tos.map(b => [a, b]));
  }
  function arcProblem(from, to) {
    const pairs = boxArcs(from, to);
    if (pairs.length === 1) return edgeProblem(...pairs[0]);
    if (nodeOf(from) === nodeOf(to)) return 'A moment cannot come after itself';
    const fresh = pairs.filter(([a, b]) => !edges.some(e => e.from === a && e.to === b));
    if (!fresh.length) return 'Those are already connected';
    if (fresh.some(([a, b]) => descendants(b).has(a))) return 'That connection would create a cycle';
    return null;
  }

  function startPending(id, side) {
    pending = { id, side };
    refreshConnectors();
    const name = nodeObj(nodeOf(id)).name;
    const question = side === 'in'
      ? `which moment comes before “${name}”?`
      : `which moment comes after “${name}”?`;
    showStatus(`Pick a green connector: ${question} (Esc to cancel)`, { sticky: true });
  }

  function cancelPending() {
    if (connDrag && connDrag.el) {   // Esc while dragging an arc
      connDrag.el.remove();
      $world.find('.task.drop-target').removeClass('drop-target');
      $canvas.removeClass('linking');
      connDrag = null;
    }
    if (!pending) return;
    pending = null;
    refreshConnectors();
    hideStatus();
  }

  function refreshConnectors() {
    $world.find('.conn').removeClass('active available blocked');
    if (!pending) return;
    const own = pending.side === 'in' ? '.conn-in' : '.conn-out';
    const other = pending.side === 'in' ? '.conn-out' : '.conn-in';
    const mine = nodeOf(pending.id);
    nodeObj(mine).$el.find(own).addClass('active');
    shownNodes().forEach(n => {
      if (n.id === mine) return;
      const e = candidateEdge(connTask(n.id, pending.side === 'in' ? 'out' : 'in'));
      n.$el.find(other).addClass(arcProblem(e.from, e.to) ? 'blocked' : 'available');
    });
  }

  // ---------------------------------------------------------------- layout
  // Height of the box padded (above or below) so that its divider is in the middle.
  function layoutHeight(t) { return 2 * Math.max(t.cy, t.h - t.cy); }

  // Order of boxes without arcs: undated moments first, in the order they were
  // added, then dated moments, by time and name.
  function looseOrder(list) {
    const undated = list.filter(t => !isDated(t));
    const dated = list.filter(isDated).sort((a, b) =>
      (parseTime(a.time) ?? 0) - (parseTime(b.time) ?? 0) || a.name.localeCompare(b.name));
    return [...undated, ...dated];
  }

  // Depth of every connected task: 0 without predecessors, else 1 + the deepest predecessor.
  function earliestLevels() {
    const level = new Map();
    const preds = new Map();
    nodeEdges(true).forEach(([from, to]) => { if (!preds.has(to)) preds.set(to, []); preds.get(to).push(from); });
    const depth = id => {
      if (level.has(id)) return level.get(id);
      level.set(id, 0);   // (the graph is acyclic; this only guards against surprises)
      const d = Math.max(-1, ...(preds.get(id) || []).map(depth)) + 1;
      level.set(id, d);
      return d;
    };
    shownNodes().forEach(n => { if (hasEdges(n.id) && !n.pinned) depth(n.id); });
    return level;
  }

  function dotSource(hints = []) {
    const q = s => '"' + s + '"';
    const lines = [
      'digraph G {',
      vertical ? '  rankdir=TB; nodesep=0.35; ranksep=0.85;'
               : '  rankdir=LR; nodesep=0.15; ranksep=0.9;',
      '  node [shape=box, fixedsize=true, label=""];',
      // The arrowhead graphviz reserves is as long as our straight end piece plus the gap
      // before the connector, so its route ends where that piece starts, already aimed right.
      `  edge [${vertical ? 'tailport=s, headport=n' : 'tailport=e, headport=w'}, arrowsize=${(ARC_TAIL + ARROW_GAP) / 10}];`,
    ];
    // Boxes without arcs all get the same size, so layout() can shuffle them
    // between their slots to put them in date order.
    const loose = shownNodes().filter(t => !t.pinned && isLoose(t));
    const looseW = Math.max(0, ...loose.map(t => t.w));
    const looseH = Math.max(0, ...loose.map(t => vertical ? t.h : layoutHeight(t)));
    shownNodes().forEach(t => {
      if (t.pinned) return;   // placed by hand, not by graphviz
      // Horizontal: graphviz lines nodes up by their centres. Give each node a height
      // that is symmetric around the divider, so the dividers (where the arcs attach) line up.
      const loosely = isLoose(t);
      const w = loosely ? looseW : t.w;
      const h = loosely ? looseH : vertical ? t.h : layoutHeight(t);
      lines.push(`  ${q(t.id)} [width=${(w / 72).toFixed(3)}, height=${(h / 72).toFixed(3)}];`);
    });
    nodeEdges().forEach(([from, to]) => lines.push(`  ${q(from)} -> ${q(to)};`));
    // Each open phase is a cluster, which keeps its moments together and other
    // boxes out, with a margin and a label that leave room for its frame.
    // Graphviz refuses a node that is both in a cluster and in a rank set
    // reaching outside it, so rank sets and order hints are kept per cluster.
    // Phases nest, and so do their clusters. A box belongs to the innermost
    // open phase around it ('' for none).
    const openPhases = [...folds.values()].filter(f => f.open && f.visible).sort((x, y) => x.members.size - y.members.size);
    const innermost = ms => (openPhases.find(f => contains(f, ms)) || { id: '' }).id;
    const clusterOf = id => innermost(membersOf(id));
    const groups = new Map();   // cluster id ('' for none) -> lines inside it
    const add = (c, line) => { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(line); };
    shownNodes().forEach(n => { const c = clusterOf(n.id); if (c) add(c, `${q(n.id)};`); });
    // Each moment as early as its predecessors allow: same rank for all moments at the
    // same depth (longest path from a moment with no predecessors).
    const levels = new Map();   // "cluster|level" -> ids
    earliestLevels().forEach((lvl, id) => {
      const k = clusterOf(id) + '|' + lvl;
      if (!levels.has(k)) levels.set(k, []);
      levels.get(k).push(q(id));
    });
    levels.forEach((ids, k) => { if (ids.length > 1) add(k.split('|')[0], `{ rank=same; ${ids.join('; ')}; }`); });
    // The user's order within a rank: invisible arcs between boxes kept in the same rank.
    hints.forEach(([a, b]) => {
      if (clusterOf(a) !== clusterOf(b)) return;
      const [x, y] = flatReversed[vertical ? 'v' : 'h'] ? [b, a] : [a, b];
      add(clusterOf(a), `{ rank=same; ${q(x)} -> ${q(y)} [style=invis]; }`);
    });
    const cluster = (f, indent) => {
      const label = f.name.replace(/[\\"]/g, '\\$&');
      lines.push(`${indent}subgraph ${q('cluster_' + f.id)} { label="${label}"; labeljust=l; fontsize=13; margin=${FRAME_PAD + 4};`);
      (groups.get(f.id) || []).forEach(l => lines.push(indent + '  ' + l));
      openPhases.filter(g => innermost(g.members) === f.id).forEach(g => cluster(g, indent + '  '));
      lines.push(indent + '}');
    };
    openPhases.filter(f => innermost(f.members) === '').forEach(f => cluster(f, '  '));
    (groups.get('') || []).forEach(l => lines.push('  ' + l));
    lines.push('}');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- overlap
  const GAP = 10;   // minimum space between boxes
  function rectAt(t, p) { return { x: p.x, y: p.y, w: t.w, h: t.h }; }
  function overlapsAny(r, rects) {
    return rects.some(o =>
      r.x < o.x + o.w + GAP && o.x < r.x + r.w + GAP &&
      r.y < o.y + o.h + GAP && o.y < r.y + r.h + GAP);
  }
  // Nearest position to p (searching outwards on a grid) where t overlaps none of rects.
  function freeSpot(t, p, rects) {
    if (!overlapsAny(rectAt(t, p), rects)) return p;
    const STEP = 20;
    for (let ring = 1; ring < 500; ring++) {
      let best = null, bestDist = Infinity;
      for (let i = -ring; i <= ring; i++) {
        for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
          const c = { x: p.x + dx * STEP, y: p.y + dy * STEP };
          const dist = dx * dx + dy * dy;
          if (dist < bestDist && !overlapsAny(rectAt(t, c), rects)) { best = c; bestDist = dist; }
        }
      }
      if (best) return best;
    }
    return p;
  }

  // Does box `id` (a task or a fold) have arcs to other boxes?
  function hasEdges(id) { return edges.some(e => !isInternal(e) && (nodeOf(e.from) === id || nodeOf(e.to) === id)); }
  // A task box without arcs: laid out in date order in the free slots, and movable by hand.
  function isLoose(n) { return tasks.has(n.id) && !hasEdges(n.id); }

  // Boxes without arcs can be dragged; once they get an arc, graphviz places them again.
  function updateMovable() {
    tasks.forEach((t, id) => {
      const movable = !hasEdges(id);
      if (!movable) delete t.pinned;
      t.$el.toggleClass('movable', movable);
    });
  }

  // Which way graphviz lays out an arc within a rank, per direction ('h', 'v'):
  // true when its tail ends up after (below / right of) its head.
  const flatReversed = {};
  function detectFlatOrder(viz) {
    for (const dir of ['h', 'v']) {
      if (dir in flatReversed) continue;
      const g = JSON.parse(viz.renderString(
        `digraph { rankdir=${dir === 'v' ? 'TB' : 'LR'}; { rank=same; a -> b; } }`, { format: 'json' }));
      const pos = {};
      g.objects.forEach(o => { if (o.pos) pos[o.name] = o.pos.split(',').map(Number); });
      // horizontal: first = top (larger graphviz y); vertical: first = left (smaller x)
      flatReversed[dir] = dir === 'v' ? pos.a[0] > pos.b[0] : pos.a[1] < pos.b[1];
    }
  }

  // rank key for each node of a graphviz result
  function ranksOf(g) {
    const H = parseFloat(g.bb.split(',')[3]);
    const m = new Map();
    (g.objects || []).forEach(o => {
      if (!o.pos || !nodeObj(o.name)) return;
      const [cx, cy] = o.pos.split(',').map(Number);
      m.set(o.name, Math.round(vertical ? H - cy : cx));
    });
    return m;
  }

  function layout() {
    const seq = ++layoutSeq;
    vizReady.then(viz => {
      if (seq !== layoutSeq) return;            // a newer layout was requested
      const render = src => JSON.parse(viz.renderString(src, { format: 'json' }));
      let g = render(dotSource());
      if (orderHints.length) {
        // Keep only hints whose boxes still share a rank (arcs may have moved
        // them apart), then lay out again with them.
        detectFlatOrder(viz);
        const r = ranksOf(g);
        const before = orderHints.length;
        orderHints = orderHints.filter(([a, b]) =>
          r.has(a) && r.has(b) && r.get(a) === r.get(b) && hasEdges(a) && hasEdges(b));
        if (orderHints.length !== before) saveLocal();
        if (orderHints.length) g = render(dotSource(orderHints));
      }
      rankOf.clear();
      ranksOf(g).forEach((k, id) => rankOf.set(id, k));
      const H = parseFloat(g.bb.split(',')[3]);
      // Arc routes: "from>to" -> bézier points (y flipped like the boxes).
      const routes = {};
      const nameOf = new Map((g.objects || []).map(o => [o._gvid, o.name]));
      (g.edges || []).forEach(ge => {
        if (ge.style === 'invis' || !ge.pos) return;
        const toks = ge.pos.split(/\s+/);
        const flip = tok => { const [x, y] = tok.split(',').map(Number); return [x, H - y]; };
        const tipTok = toks.find(tok => tok.startsWith('e,'));
        const pts = toks.filter(tok => !/^[se],/.test(tok)).map(flip);
        if (pts.length >= 4 && (pts.length - 1) % 3 === 0) {
          routes[`${nameOf.get(ge.tail)}>${nameOf.get(ge.head)}`] = { pts, tip: tipTok ? flip(tipTok.slice(2)) : null };
        }
      });
      const targets = {};
      const rankMap = new Map();   // graphviz rank coordinate -> task ids in that column/row
      const slots = [];            // centres graphviz gave the boxes without arcs
      (g.objects || []).forEach(o => {
        const t = nodeObj(o.name);
        if (!t || !o.pos) return;
        const [cx, cy] = o.pos.split(',').map(Number);
        // graphviz y points up; horizontally the divider sits on the node centre
        targets[o.name] = { x: cx - t.w / 2, y: (H - cy) - (vertical ? t.h / 2 : t.cy) };
        if (isLoose(t)) slots.push({ cx, cy: H - cy });
        const key = Math.round(vertical ? H - cy : cx);
        if (!rankMap.has(key)) rankMap.set(key, []);
        rankMap.get(key).push(o.name);
      });
      // Graphviz doesn't keep the input order of unconnected boxes; put them in
      // order ourselves (top to bottom, or left to right when vertical).
      const loose = looseOrder(shownNodes().filter(t => targets[t.id] && isLoose(t)));
      slots.sort((a, b) => vertical ? a.cx - b.cx || a.cy - b.cy : a.cy - b.cy || a.cx - b.cx);
      loose.forEach((t, i) => {
        const c = slots[i];
        targets[t.id] = { x: c.cx - t.w / 2, y: c.cy - (vertical ? t.h / 2 : t.cy) };
      });
      buildLegend([...rankMap.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids));
      // Hand-placed boxes stay put, unless the new layout now covers them;
      // then they move to the nearest free spot.
      const placed = Object.keys(targets).map(id => rectAt(nodeObj(id), targets[id]));
      tasks.forEach(t => {
        if (!t.pinned || foldOf.has(t.id)) return;
        t.pinned = freeSpot(t, t.pinned, placed);
        targets[t.id] = t.pinned;
        placed.push(rectAt(t, t.pinned));
      });
      animateTo(targets, routes);
    }).catch(err => {
      console.error(err);
      showStatus('Layout failed: ' + err.message, { error: true });
    });
  }

  // Bounding box of `boxes` plus the free screen area around them (leaving room
  // for the toolbar, and for the time legend on its side).
  function viewFrame(boxes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    boxes.forEach(b => {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    });
    const cw = $canvas.width(), ch = $canvas.height();
    const legendH = legend.visible && !vertical ? LEGEND_SIZE : 0;
    const legendV = legend.visible && vertical ? LEGEND_SIZE_V : 0;
    return {
      empty: !isFinite(minX), minX, minY, bw: maxX - minX, bh: maxY - minY, cw, ch,
      padLeft: 60 + legendV, padRight: 60, padTop: 100, padBottom: 60 + legendH,
    };
  }

  // A new task to bring into view with the next layout (see animateTo).
  let focusId = null;
  // The view that shows `box` (at the current zoom): unchanged (null) when it is
  // already fully visible, otherwise centred on it.
  function revealView(box) {
    const { cw, ch, padLeft, padRight, padTop, padBottom } = viewFrame([]);
    const k = view.k, sx = view.x + box.x * k, sy = view.y + box.y * k;
    if (sx >= padLeft && sy >= padTop && sx + box.w * k <= cw - padRight && sy + box.h * k <= ch - padBottom) return null;
    return {
      k,
      x: padLeft + (cw - padLeft - padRight) / 2 - (box.x + box.w / 2) * k,
      y: padTop + (ch - padTop - padBottom) / 2 - (box.y + box.h / 2) * k,
    };
  }

  // The whole graph in view, zoomed in up to maxK (100% unless asked otherwise).
  function fitView(boxes, maxK = 1) {
    const { empty, minX, minY, bw, bh, cw, ch, padLeft, padRight, padTop, padBottom } = viewFrame(boxes);
    if (empty) return { x: cw / 2, y: ch / 2, k: 1 };
    const k = Math.max(0.15, Math.min(maxK, (cw - padLeft - padRight) / bw, (ch - padTop - padBottom) / bh));
    return {
      x: padLeft + (cw - padLeft - padRight - bw * k) / 2 - minX * k,
      y: padTop + (ch - padTop - padBottom - bh * k) / 2 - minY * k,
      k,
    };
  }

  function currentBoxes(targets) {
    const boxes = [];
    shownNodes().forEach(t => {
      const p = (targets && targets[t.id]) || t;
      boxes.push({ x: p.x, y: p.y, w: t.w, h: t.h });
    });
    return boxes;
  }

  function animateTo(targets, routes = {}) {
    if (tween) tween.stop();
    splinesOn = false;
    freeMoving = null;
    edges.forEach(e => { e.spline = routes[`${nodeOf(e.from)}>${nodeOf(e.to)}`] || null; });

    const from = {};
    shownNodes().forEach(t => {
      const id = t.id;
      if (!targets[id]) return;
      if (t.fresh) { t.x = targets[id].x; t.y = targets[id].y; t.fresh = false; }  // new boxes fade in place
      from[id] = { x: t.x, y: t.y, o: t.o };
    });
    if (initialView) {
      // Freshly loaded graph: jump straight to the Fit view and leave it alone afterwards.
      initialView = false;
      Object.assign(view, fitView(currentBoxes(targets), MAX_ZOOM));
      applyView();
      userMoved = true;
    }
    const v0 = { ...view };
    let v1 = userMoved ? null : fitView(currentBoxes(targets));
    // After panning or zooming by hand the view stays put, except to show a new task.
    const reveal = userMoved && focusId && targets[focusId];
    if (reveal) v1 = revealView({ ...targets[focusId], w: tasks.get(focusId).w, h: tasks.get(focusId).h });
    focusId = null;
    const lerp = (a, b, s) => a + (b - a) * s;

    tween = $({ s: 0 }).animate({ s: 1 }, {
      duration: ANIM_MS,
      easing: 'swing',
      step(s) {
        for (const id in from) {
          const t = nodeObj(id), f = from[id], to = targets[id];
          t.x = lerp(f.x, to.x, s);
          t.y = lerp(f.y, to.y, s);
          t.o = lerp(f.o, 1, s);
          t.$el.css({ left: t.x, top: t.y, opacity: t.o });
        }
        if (v1 && (reveal || !userMoved)) {
          view.x = lerp(v0.x, v1.x, s);
          view.y = lerp(v0.y, v1.y, s);
          view.k = lerp(v0.k, v1.k, s);
          applyView();
        }
        drawEdges();
        positionLegend();
      },
      complete() { tween = null; splinesOn = true; drawEdges(); },
    });
  }

  let viewTween = null;
  function animateViewTo(v1, duration = ANIM_MS) {
    if (viewTween) viewTween.stop(true, true);   // finish the previous one so repeated clicks add up
    const v0 = { ...view };
    viewTween = $({ s: 0 }).animate({ s: 1 }, {
      duration,
      step(s) {
        view.x = v0.x + (v1.x - v0.x) * s;
        view.y = v0.y + (v1.y - v0.y) * s;
        view.k = v0.k + (v1.k - v0.k) * s;
        applyView();
      },
      complete() { viewTween = null; },
    });
  }

  const MIN_ZOOM = 0.1, MAX_ZOOM = 3;

  // The view after zooming to scale k, keeping screen point (mx, my) fixed.
  function zoomedView(k, mx, my) {
    const k2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
    return {
      x: mx - (mx - view.x) * (k2 / view.k),
      y: my - (my - view.y) * (k2 / view.k),
      k: k2,
    };
  }

  // Zoom buttons: zoom around the centre of the window.
  function zoomTo(k) {
    userMoved = true;
    animateViewTo(zoomedView(k, $canvas.width() / 2, $canvas.height() / 2), 180);
  }

  // ---------------------------------------------------------------- save / load
  // Separate from the task editor's keys, so the two don't overwrite each other's graph.
  const STORAGE_KEY = 'moment-dag-editor:v1';

  function serialize() {
    return {
      format: 'moment-dag',
      version: 1,
      layout: vertical ? 'vertical' : 'horizontal',
      timeUnit: hourMode ? 'hour' : 'day',
      ...(graphWait ? { wait: graphWait } : {}),
      tasks: [...tasks.values()].map(t => ({
        id: t.id, name: t.name, time: t.time,
        ...(t.notes ? { notes: t.notes } : {}),
        ...(t.locked ? { locked: true } : {}),
        ...(t.pinned ? { pos: { x: Math.round(t.pinned.x), y: Math.round(t.pinned.y) } } : {}),
      })),
      edges: edges.map(e => ({ from: e.from, to: e.to, ...(e.wait != null ? { wait: e.wait } : {}) })),
      ...(orderHints.length ? { order: orderHints.map(h => [...h]) } : {}),
      ...(folds.size ? { folds: [...folds.values()].map(f => ({ id: f.id, name: f.name, members: [...f.members], ...(f.open ? { open: true } : {}) })) } : {}),
    };
  }

  // Called after every edit: re-layout and autosave to the browser.
  // opts.coalesce: a key for edits that come in a stream (typing a name or notes);
  // quick successive edits with the same key become one undo step.
  function changed(opts = {}) {
    updateShowDates();
    refreshFolds();
    showPicks();
    updateHiddenEdges();
    updateConflicts();
    updateCritical();
    updateMovable();
    layout();
    if (selectedId) fillProps();
    checkNewConflicts(!opts.quiet);
    const json = saveLocal();
    recordHistory(json, opts.coalesce);
  }
  function saveLocal() {
    const json = JSON.stringify(serialize());
    try { localStorage.setItem(STORAGE_KEY, json); } catch (_) { /* storage unavailable */ }
    return json;
  }

  // ---------------------------------------------------------------- undo / redo
  // Snapshots of the graph (the same JSON as the autosave) after every change.
  const HISTORY_MAX = 200;
  const undoHistory = { states: [], index: -1, lastKey: null, lastTime: 0 };
  let restoring = false;

  function recordHistory(json, key) {
    if (restoring || undoHistory.states[undoHistory.index] === json) return;
    const now = Date.now();
    const atEnd = undoHistory.index === undoHistory.states.length - 1;
    if (key && key === undoHistory.lastKey && atEnd && undoHistory.index > 0 && now - undoHistory.lastTime < 1500) {
      undoHistory.states[undoHistory.index] = json;          // still typing: same step
    } else {
      undoHistory.states.splice(undoHistory.index + 1);      // a new change drops what could be redone
      undoHistory.states.push(json);
      if (undoHistory.states.length > HISTORY_MAX) undoHistory.states.shift();
      undoHistory.index = undoHistory.states.length - 1;
    }
    undoHistory.lastKey = key || null;
    undoHistory.lastTime = now;
    updateUndoButtons();
  }

  function updateUndoButtons() {
    $('#undo').prop('disabled', undoHistory.index <= 0);
    $('#redo').prop('disabled', undoHistory.index >= undoHistory.states.length - 1);
  }

  // Put the graph back to a snapshot; boxes slide from where they are now.
  function restoreState(json) {
    const sel = selectedId;
    const prev = new Map([...tasks, ...folds].map(([id, t]) => [id, nodeObj(nodeOf(id))]).map(([id, n]) => [id, { x: n.x, y: n.y }]));
    if (pending) cancelPending();
    restoring = true;
    try { loadGraph(JSON.parse(json), { keepView: true, prev }); } finally { restoring = false; }
    undoHistory.lastKey = null;
    if (sel && tasks.has(sel) && !foldOf.has(sel)) openProps(sel);
    updateUndoButtons();
  }
  function undo() {
    if (undoHistory.index <= 0) { showStatus('Nothing to undo'); return; }
    restoreState(undoHistory.states[--undoHistory.index]);
    showStatus('Undone');
  }
  function redo() {
    if (undoHistory.index >= undoHistory.states.length - 1) { showStatus('Nothing to redo'); return; }
    restoreState(undoHistory.states[++undoHistory.index]);
    showStatus('Redone');
  }
  $('#undo').on('click', undo);
  $('#redo').on('click', redo);

  function clearGraph() {
    if (tween) { tween.stop(); tween = null; }
    closeProps();
    pending = null;
    hideStatus();
    tasks.forEach(t => t.$el.remove());
    tasks.clear();
    edges.forEach(e => e.el.remove());
    edges = [];
    folds.forEach(f => { f.$el.remove(); f.$frame.remove(); });
    folds.clear();
    foldOf.clear();
    nextFoldId = 1;
    orderHints = [];
    graphWait = null;
    updateWaitMenu();
    nextId = 1;
    $empty.show();
  }

  // Replace the current graph with `data`. Throws on malformed input.
  // opts.keepView: undo/redo — keep the view, and slide boxes from opts.prev positions.
  function loadGraph(data, opts = {}) {
    if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.edges)) {
      throw new Error('Not a graph file');
    }
    clearGraph();
    if (data.layout === 'vertical' || data.layout === 'horizontal') setVertical(data.layout === 'vertical');
    setHourMode(data.timeUnit === 'hour');   // files without it are in days
    const validWait = w => typeof w === 'string' && parseDuration(w) != null ? durationValue(parseDuration(w)) : null;
    graphWait = validWait(data.wait);
    updateWaitMenu();
    let skipped = 0;
    data.tasks.forEach(t => {
      if (!t || typeof t.name !== 'string') { skipped++; return; }
      const id = typeof t.id === 'string' && /^t\d+$/.test(t.id) && !tasks.has(t.id) ? t.id : null;
      if (!id) { skipped++; return; }
      // Task graphs (start / end) open too: a task becomes the moment it starts (or else ends).
      const task = createTask({ id, name: t.name, time: t.time ?? t.start ?? t.end, notes: t.notes, locked: t.locked });
      const was = opts.prev && opts.prev.get(id);
      if (was) {   // the same box as before: move it from where it was instead of fading in
        Object.assign(task, { x: was.x, y: was.y, o: 1, fresh: false });
        task.$el.css({ left: was.x, top: was.y, opacity: 1 });
      }
      if (t.pos && isFinite(t.pos.x) && isFinite(t.pos.y)) task.pinned = { x: +t.pos.x, y: +t.pos.y };
      nextId = Math.max(nextId, parseInt(id.slice(1), 10) + 1);
    });
    data.edges.forEach(e => {
      if (!e || !tasks.has(e.from) || !tasks.has(e.to) || edgeProblem(e.from, e.to)) { skipped++; return; }
      addEdge(e.from, e.to, validWait(e.wait));
    });
    if (Array.isArray(data.order)) {
      orderHints = data.order.filter(h => Array.isArray(h) && h.length === 2 &&
        tasks.has(h[0]) && tasks.has(h[1]) && h[0] !== h[1]).map(h => [h[0], h[1]]);
    }
    if (Array.isArray(data.folds)) {
      data.folds.forEach(f => {
        if (!f || typeof f.id !== 'string' || !/^f\d+$/.test(f.id) || folds.has(f.id)) return;
        let ms;
        if (Array.isArray(f.members)) ms = new Set(f.members.filter(id => tasks.has(id)));
        else { const r = foldRegion(f.entry, f.exit); ms = r.error ? new Set() : r.members; }   // an older file: first and last moment
        if (!ms.size) return;
        between(ms).forEach(id => ms.add(id));
        if (nestProblem(ms)) return;   // cutting across another phase: show its moments
        const fold = createFold({ id: f.id, name: typeof f.name === 'string' && f.name.trim() ? f.name : null, members: ms, open: f.open === true });
        const was = opts.prev && opts.prev.get(f.id);
        if (was) {
          Object.assign(fold, { x: was.x, y: was.y, o: 1 });
          fold.$el.css({ left: was.x, top: was.y, opacity: 1 });
        }
        nextFoldId = Math.max(nextFoldId, parseInt(f.id.slice(1), 10) + 1);
      });
    }
    if (!opts.keepView) {
      userMoved = false;
      initialView = true;   // show the loaded graph as large as fits, like the Fit button
    }
    changed({ quiet: true });
    return skipped;
  }

  // The name the graph was last opened or saved as; suggested the next time it's saved.
  const FILE_NAME_KEY = 'moment-dag-editor:file-name';
  let fileName = null;
  try { fileName = localStorage.getItem(FILE_NAME_KEY); } catch (_) { /* storage unavailable */ }
  function setFileName(name) {
    fileName = name || null;
    document.title = fileName ? `${fileName} — Moment DAG Editor` : 'Moment DAG Editor';
    const project = fileName ? fileName.replace(/\.json$/i, '') : '';
    $input.attr('placeholder', project ? `New ${project} moment… (Enter to add)` : 'New moment… (Enter to add)');
    try {
      if (fileName) localStorage.setItem(FILE_NAME_KEY, fileName); else localStorage.removeItem(FILE_NAME_KEY);
    } catch (_) { /* storage unavailable */ }
  }

  // Chrome and Edge: the file last saved or opened, so Save can write to it again.
  let fileHandle = null;
  const FILE_TYPES = [{ description: 'Moment graph', accept: { 'application/json': ['.json'] } }];

  // A name typed by the user as a file name: no path characters, ending in .json.
  function cleanName(name) {
    name = String(name).trim().replace(/[\\/:*?"<>|]+/g, '-');
    if (!name) return null;
    return /\.json$/i.test(name) ? name : name + '.json';
  }

  async function writeHandle(handle, text) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  }

  // Save: to the graph's name without asking (the same file again in Chrome and
  // Edge; a download elsewhere). Save as, or Save without a name: ask for one.
  // Chrome and Edge show the system's save dialog (name and folder); other
  // browsers ask for a name and download the file.
  async function saveToFile(asNew = false) {
    const text = JSON.stringify(serialize(), null, 2);
    const saved = () => showStatus(`Saved “${fileName}” (${tasks.size} moments, ${edges.length} arcs)`);
    if (!asNew && fileName) {
      if (fileHandle) {
        try { await writeHandle(fileHandle, text); saved(); return; }
        catch (_) { /* no longer allowed or gone: ask where, below */ }
      } else if (!window.showSaveFilePicker) {
        download(text, fileName);
        saved();
        return;
      }
    }
    const suggested = fileName || 'moment-graph.json';
    if (window.showSaveFilePicker) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: suggested, types: FILE_TYPES });
      } catch (err) {
        if (err.name === 'AbortError') return;      // cancelled
        // Not allowed here (e.g. inside a frame): fall back to a download.
        return downloadAs(text, suggested, saved);
      }
      try {
        await writeHandle(handle, text);
        fileHandle = handle;
        setFileName(handle.name);
        saved();
      } catch (err) {
        showStatus('Could not save: ' + err.message, { error: true });
      }
      return;
    }
    downloadAs(text, suggested, saved);
  }

  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    $('<a>').attr({ href: url, download: name })[0].click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadAs(text, suggested, done) {
    const answer = await askText({ title: 'Save as', value: suggested, confirm: 'Save', selectName: true });
    if (answer == null) return;                     // cancelled
    const name = cleanName(answer) || 'moment-graph.json';
    download(text, name);
    fileHandle = null;
    setFileName(name);
    done();
  }

  function openText(text, name, handle = null) {
    try {
      const skipped = loadGraph(JSON.parse(text));
      fileHandle = handle;
      setFileName(name);
      showStatus(`Opened “${name}”` + (skipped ? ` (${skipped} invalid items skipped)` : ''));
    } catch (err) {
      showStatus(`Could not open “${name}”: ${err.message}`, { error: true });
    }
  }

  // Chrome and Edge: the system's open dialog, keeping the file so Save writes back to it.
  async function openFile() {
    if (window.showOpenFilePicker) {
      let handle;
      try {
        [handle] = await window.showOpenFilePicker({ types: FILE_TYPES });
      } catch (err) {
        if (err.name === 'AbortError') return;      // cancelled
        $('#file-input').val('').trigger('click');  // not allowed here: the plain file chooser
        return;
      }
      try {
        const file = await handle.getFile();
        openText(await file.text(), file.name, handle);
      } catch (err) {
        showStatus('Could not open the file: ' + err.message, { error: true });
      }
      return;
    }
    $('#file-input').val('').trigger('click');
  }

  $('#file-input').on('change', function () {
    const file = this.files && this.files[0];
    if (!file) return;
    file.text().then(text => openText(text, file.name),
      err => showStatus(`Could not open “${file.name}”: ${err.message}`, { error: true }));
  });

  $('#save').on('click', () => saveToFile());
  $('#save-as').on('click', () => saveToFile(true));
  $('#open').on('click', openFile);
  $('#new').on('click', async () => {
    const answer = await askText({
      title: 'New graph', value: 'Untitled', confirm: 'Create', selectName: true,
      text: tasks.size ? 'Name the new graph. It replaces this one; unsaved changes are lost (Undo brings it back).' : 'Name the new graph.',
    });
    if (answer == null) return;                     // cancelled
    clearGraph();
    fileHandle = null;
    setFileName(cleanName(answer));
    userMoved = false;
    changed();
  });

  $(document).on('keydown', e => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'y') {
      // In a text field with text in it, the field's own undo comes first.
      const el = e.target;
      if ($(el).is('input, textarea') && !(el === $input[0] && el.value === '')) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
      return;
    }
    if (k === 's') { e.preventDefault(); saveToFile(e.shiftKey); }
    else if (k === 'o') { e.preventDefault(); openFile(); }
  });

  // ---------------------------------------------------------------- input
  $input.on('keydown', e => {
    if (e.key === 'Enter') {
      const name = $input.val().trim();
      if (name) addTask(name);
      $input.val('');
      e.preventDefault();
    } else if (e.key === 'Escape') {
      cancelPending();
    }
  });

  // Keep keyboard focus in the task field: suppress focus changes on mousedown
  // everywhere except form fields and the properties panel.
  $(document).on('mousedown', e => {
    if (!$(e.target).closest('input, select, textarea, [contenteditable], #props').length) e.preventDefault();
  });
  // Only with a mouse: on a phone, focusing the field would pop up the keyboard on every tap.
  $(document).on('pointerup', ev => {
    if (ev.originalEvent.pointerType === 'mouse' && !$(ev.target).closest('#props, .swal2-container, .phase-label, [contenteditable]').length) $input.trigger('focus');
  });

  // Either connector can start a connection; the opposite side of other boxes
  // then turns green. Clicking a green one completes the edge.
  // Finish the pending connection at task `id` (the other end of the arc).
  function completePending(id) {
    const edge = candidateEdge(id);
    const problem = arcProblem(edge.from, edge.to);
    if (problem) { showStatus(problem, { error: true }); return; }
    const pairs = boxArcs(edge.from, edge.to);
    cancelPending();
    if (pairs.length === 1) { connect(...pairs[0]); return; }
    pairs.forEach(([a, b]) => { if (!edges.some(e => e.from === a && e.to === b)) addEdge(a, b); });
    changed();
    showStatus(`Connected with ${pairs.length} arcs, so the whole phase follows`);
  }
  // Add the arc from -> to (already checked with edgeProblem) and say if it is
  // special; returns true when it did.
  function connect(from, to) {
    const edge = { from, to };
    const implied = descendants(edge.from).has(edge.to);
    const added = addEdge(edge.from, edge.to);
    changed();
    if (added.conflict) {
      const a = tasks.get(edge.from), b = tasks.get(edge.to);
      showStatus(`Date conflict: “${b.name}” comes before “${a.name}”`, { error: true });
      return true;
    }
    if (implied) {
      showStatus(`“${tasks.get(edge.from).name}” already comes before “${tasks.get(edge.to).name}” through other moments, so this arc is not drawn`);
      return true;
    }
    return false;
  }

  $world.on('click', '.conn', function (e) {
    e.stopPropagation();
    if (suppressClick) return;   // the end of dragging an arc
    const side = $(this).hasClass('conn-in') ? 'in' : 'out';
    const id = connTask($(this).closest('.task').attr('data-id'), side);

    if (pending && pending.side !== side && nodeOf(pending.id) !== nodeOf(id)) {
      completePending(id);
    } else if (pending && nodeOf(pending.id) === nodeOf(id) && pending.side === side) {
      cancelPending();
    } else {
      startPending(id, side);
    }
  });

  $edgeLayer.on('click', '.edge', function (e) {
    e.stopPropagation();
    const edge = edges.find(x => x.el === this);
    if (edge) editArc(edge);
  });

  // Set an arc's own wait, or remove the arc. (Without SweetAlert: remove, as before.)
  function waitHint() { return hourMode ? 'Like 30m, 2h or 1d 4h' : 'A number of days, like 2'; }
  async function editArc(edge) {
    if (!hasSwal) { removeEdge(edge); return; }
    const a = tasks.get(edge.from), b = tasks.get(edge.to);
    const def = parseDuration(graphWait) ?? 0;
    const r = await dialog.fire({
      titleText: `${a.name} → ${b.name}`,
      text: `The least time from “${a.name}” to “${b.name}”. ` +
            `Leave it empty to use the graph’s wait (${def ? waitText(def) : 'none'}).`,
      input: 'text', inputValue: edge.wait != null ? String(durationInput(parseDuration(edge.wait) ?? 0)) : '',
      inputPlaceholder: def ? waitText(def) : 'No wait',
      inputAttributes: { autocomplete: 'off' },
      showCancelButton: true, showDenyButton: true,
      confirmButtonText: 'Save', denyButtonText: 'Remove arc', denyButtonColor: '#cf222e',
      inputValidator: v => !v.trim() || parseDuration(v) != null ? null : waitHint(),
    });
    if (r.isDenied) { removeEdge(edge); return; }
    if (!r.isConfirmed || !edges.includes(edge)) return;
    const v = r.value.trim();
    const wait = v ? durationValue(parseDuration(v)) : null;
    if (wait === edge.wait) return;
    edge.wait = wait;
    drawEdge(edge);
    changed();
  }

  // The graph's wait between moments (menu).
  function updateWaitMenu() {
    const n = parseDuration(graphWait) ?? 0;
    $('#wait-default .menu-value').text(n ? waitText(n) : 'none');
  }
  $('#wait-default').on('click', async () => {
    if (!hasSwal) return;
    const n = parseDuration(graphWait) ?? 0;
    const r = await dialog.fire({
      titleText: 'Wait between moments',
      text: 'The least time between a moment and the moments that come after it, unless their arc has its own wait. ' +
            (hourMode ? 'E.g. 15m.' : 'E.g. 1, so that a later moment is at least the next day.') +
            ' Empty for none: a later moment may then be at the same time.',
      input: 'text', inputValue: n ? String(durationInput(n)) : '', inputPlaceholder: 'No wait',
      inputAttributes: { autocomplete: 'off' },
      showCancelButton: true, confirmButtonText: 'Save',
      inputValidator: v => !v.trim() || parseDuration(v) != null ? null : waitHint(),
    });
    if (!r.isConfirmed) return;
    const v = r.value.trim(), m = v ? parseDuration(v) : 0;
    const wait = m ? durationValue(m) : null;
    if (wait === graphWait) return;
    graphWait = wait;
    updateWaitMenu();
    edges.forEach(drawEdge);
    changed();
  });

  // Fit: as large as possible with the whole graph visible.
  $('#zoom-fit').on('click', () => {
    userMoved = true;   // a one-off view; don't let auto-fit undo it
    animateViewTo(fitView(currentBoxes(), MAX_ZOOM));
  });

  // ---------------------------------------------------------------- menu
  const $menu = $('#menu'), $menuBtn = $('#menu-btn');
  function toggleMenu(open) {
    if (open === undefined) open = $menu.prop('hidden');
    $menu.prop('hidden', !open);
    $menuBtn.attr('aria-expanded', String(open)).toggleClass('active', open);
  }
  $menuBtn.on('click', () => toggleMenu());
  $menu.on('click', 'button', () => toggleMenu(false));   // each item's own handler runs first
  $(document).on('pointerdown', e => { if (!$(e.target).closest('.menu-wrap').length) toggleMenu(false); });
  $(document).on('keydown', e => { if (e.key === 'Escape' && !$menu.prop('hidden')) toggleMenu(false); });

  function setShowLegend(v) {
    showLegend = v;
    $('#legend-toggle').attr('aria-checked', String(v));
    try { localStorage.setItem(LEGEND_PREF_KEY, v ? '1' : '0'); } catch (_) { /* storage unavailable */ }
    buildLegend(legend.rankIds || []);
    if (!userMoved && tasks.size) animateViewTo(fitView(currentBoxes()));   // make room for it, or take it back
  }
  $('#legend-toggle').attr('aria-checked', String(showLegend))
    .on('click', () => setShowLegend(!showLegend));
  $('#critical-toggle').attr('aria-checked', String(showCritical))
    .on('click', () => setShowCritical(!showCritical));
  // "<": an arc from the second newest moment to the newest one, so that typing
  // "Shop", Enter, "Cook", Enter, < makes "Shop" come before "Cook".
  function linkNewest() {
    const [b, a] = [...tasks.values()].sort((x, y) => parseInt(y.id.slice(1), 10) - parseInt(x.id.slice(1), 10));
    if (!a) { showStatus('Add two moments first'); return; }
    const problem = edgeProblem(a.id, b.id);
    if (problem) { showStatus(problem, { error: true }); return; }
    if (foldOf.has(a.id) || foldOf.has(b.id)) { showStatus('One of them is in a phase; unfold it first', { error: true }); return; }
    cancelPending();
    if (!connect(a.id, b.id)) showStatus(`Connected “${a.name}” → “${b.name}”`);
  }
  $(document).on('keydown', e => {
    if (e.key !== '<' || e.metaKey || e.ctrlKey) return;
    const el = e.target;
    if ($(el).is('input, textarea') && !(el === $input[0] && el.value === '')) return;
    e.preventDefault();
    linkNewest();
  });

  // "/": a new moment right after the selected one (or else the newest). The
  // selected moment keeps its incoming arcs; the new one comes after it and
  // takes over the outgoing arcs, so it slots in between. It has no time yet.
  async function insertAfter(t) {
    const name = await askText({
      title: `A new moment after “${t.name}”?`,
      text: 'It comes right after it, and the moments that came after it now come after the new one. Name it:',
      value: '', confirm: 'Add',
    });
    if (name == null || !tasks.has(t.id) || foldOf.has(t.id)) return;
    const id = 't' + nextId++;
    createTask({ id, name: name.trim(), locked: t.locked });
    edges.forEach(x => { if (x.from === t.id) x.from = id; });
    addEdge(t.id, id);
    orderHints = orderHints.filter(h => !h.includes(t.id));
    focusId = id;
    if (pending) cancelPending();
    changed();
    showStatus(`Added “${name.trim()}” after “${t.name}”`, { action: { label: 'Undo', run: undo } });
  }
  $(document).on('keydown', e => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
    const el = e.target;
    if ($(el).is('input, textarea') && !(el === $input[0] && el.value === '')) return;
    e.preventDefault();
    const newest = [...tasks.values()].sort((x, y) => parseInt(y.id.slice(1), 10) - parseInt(x.id.slice(1), 10))[0];
    const t = selectedId ? tasks.get(selectedId) : newest;
    if (!t) { showStatus('Add a moment first'); return; }
    if (foldOf.has(t.id)) { showStatus('That moment is in a phase; unfold it first', { error: true }); return; }
    insertAfter(t);
  });

  // Delete or Backspace deletes the picked boxes, or the moment in the
  // properties panel, unless something is being typed.
  $(document).on('keydown', e => {
    if (e.key !== 'Delete' && e.key !== 'Backspace' || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target;
    if ($(el).is('input, textarea, select, [contenteditable]') && !(el === $input[0] && el.value === '')) return;
    if (!picked.size && !selectedId) return;
    e.preventDefault();
    deleteBoxes(picked.size ? [...picked] : [selectedId]);
  });

  // "!" toggles the critical path, unless it's being typed into a field.
  $(document).on('keydown', e => {
    if (e.key !== '!' || e.metaKey || e.ctrlKey) return;
    const el = e.target;
    if ($(el).is('input, textarea') && !(el === $input[0] && el.value === '')) return;
    e.preventDefault();
    setShowCritical(!showCritical);
  });

  $('#direction, #direction-menu').on('click', () => {
    setVertical(!vertical);
    userMoved = false;   // re-fit the view to the new shape
    changed();
  });

  // ---------------------------------------------------------------- days / hours
  function setHourMode(v) {
    hourMode = v;
    $('#unit-toggle').attr('aria-checked', String(v));
    $('#props').toggleClass('hours', v);
    $('#p-time').attr('type', v ? 'datetime-local' : 'date')
      .attr('step', v ? 60 : null);   // whole minutes: no seconds field
    $('#p-time-label').text(v ? 'Date and time' : 'Date');
  }

  // In hour mode, boxes show the date under the time when the graph covers more than one date.
  function updateShowDates() {
    let v = false;
    if (hourMode) {
      const days = new Set();
      tasks.forEach(t => {
        const n = parseDateTime(t.time);
        if (n != null) days.add(Math.floor(n / MIN_PER_DAY));
      });
      v = days.size > 1;
    }
    if (v === showDates) return;
    showDates = v;
    tasks.forEach(renderTask);
  }

  // Convert every moment's time to the other unit. Days -> hours is exact
  // (Nov 14 becomes Nov 14 00:00); hours -> days drops the time of day, so it
  // asks first when there is any.
  async function switchTimeUnit(toHours) {
    const conv = [...tasks.values()].map(t => {
      if (toHours) {
        const d = parseDate(t.time);
        return { t, lossy: false, time: d != null ? isoFromMinute(d * MIN_PER_DAY) : null };
      }
      const m = parseDateTime(t.time);
      return { t, lossy: m != null && m % MIN_PER_DAY !== 0,
               time: m != null ? isoFromDay(Math.floor(m / MIN_PER_DAY)) : null };
    });
    // Waits: days -> minutes; minutes -> whole days, rounded up.
    const convWait = w => {
      if (w == null) return { w: null, lossy: false };
      if (toHours) { const d = parseDays(w); return { w: d != null ? `${d * MIN_PER_DAY}m` : null, lossy: false }; }
      const m = parseMinutes(w);
      return m == null ? { w: null, lossy: false } : { w: `${Math.ceil(m / MIN_PER_DAY)}d`, lossy: m % MIN_PER_DAY !== 0 };
    };
    const waits = edges.map(e => [e, convWait(e.wait)]), gw = convWait(graphWait);
    const lossyWaits = waits.filter(([, c]) => c.lossy).length + (gw.lossy ? 1 : 0);
    const lossy = conv.filter(c => c.lossy).length;
    if (lossyWaits && !lossy && !await confirmAction({
      title: 'Switch to whole days?', confirm: 'Switch',
      text: `${lossyWaits} wait${lossyWaits === 1 ? '' : 's'} will be rounded up to whole days.`,
    })) return;
    if (lossy && !await confirmAction({
      title: 'Switch to whole days?', confirm: 'Switch',
      text: `The times of day of ${lossy} moment${lossy === 1 ? '' : 's'} will be dropped.`,
    })) return;
    setHourMode(toHours);
    waits.forEach(([e, c]) => { e.wait = c.w; });
    graphWait = gw.w;
    updateWaitMenu();
    conv.forEach(({ t, time }) => { t.time = time; });
    updateShowDates();
    tasks.forEach(renderTask);   // every box shows its times in the new unit
    changed();
    showStatus(toHours ? 'Times are now in hours and minutes' : 'Times are now in whole days');
  }
  $('#unit-toggle').on('click', () => switchTimeUnit(!hourMode));

  // ---------------------------------------------------------------- box order
  // Position along the rank (top to bottom; left to right when vertical).
  function along(t) { return vertical ? t.x + t.w / 2 : t.y + t.cy; }

  // After dragging connected box t along its rank: if it passed a neighbour,
  // fix the rank's new order and return true.
  function reorderRank(t, start) {
    const key = rankOf.get(t.id);
    if (key == null) return false;
    const members = [...tasks.values()].filter(o => rankOf.get(o.id) === key && hasEdges(o.id) && !o.pinned);
    if (members.length < 2) return false;
    const pos = o => o === t ? along(start) : along(o);
    const oldOrder = [...members].sort((a, b) => pos(a) - pos(b)).map(o => o.id);
    const newOrder = [...members].sort((a, b) => along(a) - along(b)).map(o => o.id);
    if (oldOrder.join() === newOrder.join()) return false;
    const inRank = new Set(newOrder);
    orderHints = orderHints.filter(([a, b]) => !inRank.has(a) && !inRank.has(b));
    for (let i = 1; i < newOrder.length; i++) orderHints.push([newOrder[i - 1], newOrder[i]]);
    return true;
  }

  $('#reset-order').on('click', () => {
    if (!orderHints.length) { showStatus('The boxes are already in the automatic order'); return; }
    orderHints = [];
    changed();
    showStatus('Box order reset');
  });

  const ZOOM_STEP = 1.25;
  $('#zoom-in').on('click', () => zoomTo(view.k * ZOOM_STEP));
  $('#zoom-out').on('click', () => zoomTo(view.k / ZOOM_STEP));

  // ---------------------------------------------------------------- help
  const $help = $('#help');
  function toggleHelp(show) {
    $help.prop('hidden', show === undefined ? !$help.prop('hidden') : !show);
  }
  $('#help-btn').on('click', () => toggleHelp());
  $('#help-close').on('click', () => toggleHelp(false));
  $help.on('click', e => { if (e.target === $help[0]) toggleHelp(false); });  // click on backdrop
  $(document).on('keydown', e => {
    if (e.key === 'Escape' && !$help.prop('hidden')) { toggleHelp(false); e.stopImmediatePropagation(); }
  });

  // ---------------------------------------------------------------- pan & zoom
  // ---------------------------------------------------------------- properties panel
  const $props = $('#props');
  let selectedId = null;
  let suppressClick = false;

  function isoFromDay(n) { return new Date(n * DAY_MS).toISOString().slice(0, 10); }
  function isoOrEmpty(v) { const n = parseTime(v); return n != null ? formatTime(n) : ''; }

  function openProps(id) {
    // A moment inside folded phases (e.g. picked in the dependency list): open them, outermost first.
    while (foldOf.has(id) && !folds.get(foldOf.get(id)).open) expandFold(foldOf.get(id), { quiet: true });
    flushDates();
    cancelPending();
    selectedId = id;
    $world.find('.task.selected').removeClass('selected');
    tasks.get(id).$el.addClass('selected');
    $props.prop('hidden', false);
    fillProps();
  }

  function closeProps() {
    flushDates();
    if (!selectedId) return;
    const t = tasks.get(selectedId);
    if (t) t.$el.removeClass('selected');
    selectedId = null;
    $props.prop('hidden', true);
    focusInput();
  }

  function depItem(task, edge) {
    return $('<li>').append(
      $('<button type="button" class="dep-name">').text(task.name).attr('title', 'Show this moment')
        .on('click', () => openProps(task.id)),
      waitOf(edge) > 0 ? $('<span class="dep-note">').text(`wait ${waitText(waitOf(edge))}`) : null,
      edge.hidden ? $('<span class="dep-note">').text('implied, not drawn') : null,
      $('<button type="button" class="dep-remove" aria-label="Remove dependency">×</button>')
        .attr('title', 'Remove this dependency')
        .on('click', () => removeEdge(edge))
    );
  }

  // Refresh the panel from the model (keeps the field being typed in untouched).
  function fillProps() {
    const t = tasks.get(selectedId);
    if (!t) { closeProps(); return; }
    const active = document.activeElement;
    const set = (sel, v) => { const el = $(sel)[0]; if (el !== active) el.value = v; };
    set('#p-name', t.name);
    set('#p-notes', t.notes || '');

    // A missing time is pre-filled with a suggestion from neighbouring moments.
    const sug = suggestTiming(t);
    set('#p-time', isoOrEmpty(t.time) || sug.time || '');
    $('#p-time').toggleClass('suggested', !!sug.time);
    $('#p-suggest').prop('hidden', !sug.any);
    $('#p-suggest-text').text(sug.reason);
    $('#p-locked').prop('checked', !!t.locked);
    $('#p-slack').prop('hidden', !t.slack).text(t.slack ? slackText(t.slack) : '')
      .toggleClass('critical', !!t.slack && t.slack.slack <= 0);
    // ×: only for a time the moment really has (not a suggestion).
    $props.find('.clear[data-key="time"]').prop('hidden', !t.time);

    const problems = t.problems || [];
    $('#p-conflicts').prop('hidden', !problems.length).empty().append(
      $('<strong>').text('Date conflict'),
      $('<ul>').append(problems.map(p => $('<li>').text(p))));

    const before = edges.filter(e => e.to === t.id);
    const after = edges.filter(e => e.from === t.id);
    $('#p-before').empty().append(before.length ? before.map(e => depItem(tasks.get(e.from), e))
                                                : $('<li class="none">').text('Nothing'));
    $('#p-after').empty().append(after.length ? after.map(e => depItem(tasks.get(e.to), e))
                                              : $('<li class="none">').text('Nothing'));
  }

  // Suggested time for a moment without one: as early as the moments before it
  // allow (the latest of them, plus any wait), or else as late as the moments
  // after it allow.
  function suggestTiming(t) {
    if (parseTime(t.time) != null) return { time: null, any: false, reason: '' };
    const after = edges.filter(x => x.to === t.id).map(x => {
      const v = parseTime(tasks.get(x.from).time);
      return v != null ? v + minGap(x) : null;
    }).filter(v => v != null);
    const before = edges.filter(x => x.from === t.id).map(x => {
      const v = parseTime(tasks.get(x.to).time);
      return v != null ? v - minGap(x) : null;
    }).filter(v => v != null);
    let time = null, reason = '';
    if (after.length) { time = Math.max(...after); reason = 'Suggested: as soon as the moments before it allow.'; }
    else if (before.length) { time = Math.min(...before); reason = 'Suggested: as late as the moments after it allow.'; }
    return { time: time != null ? formatTime(time) : null, any: time != null, reason };
  }

  function acceptSuggestion() {
    const t = tasks.get(selectedId);
    if (!t) return;
    const sug = suggestTiming(t);
    if (sug.time) t.time = sug.time;
    renderTask(t);
    changed();
  }

  // ---------------------------------------------------------------- resolve conflicts
  // Move moments that come too early (before a moment they come after, plus
  // any wait) later by just enough; the move carries on to the moments after
  // them. Locked moments never move: they stay in conflict and are reported.
  // Returns { moves: id -> {time}, shift: id -> amount, blocked: [ids] }.
  function planPush() {
    const cur = new Map([...tasks].map(([id, t]) => [id, parseTime(t.time)]));
    const moves = new Map(), shift = new Map(), blocked = [];
    topoOrder().forEach(id => {
      const t = tasks.get(id), at = cur.get(id);
      if (at == null) return;
      const ends = edges.filter(x => x.to === id).map(x => {
        const v = cur.get(x.from);
        return v != null ? v + minGap(x) : null;
      }).filter(v => v != null);
      if (!ends.length) return;
      const need = Math.max(...ends) - at;
      if (need <= 0) return;
      if (t.locked) { blocked.push(id); return; }
      cur.set(id, at + need);
      shift.set(id, need);
      moves.set(id, { time: formatTime(at + need) });
    });
    return { moves, shift, blocked };
  }

  function planEnd() {
    const ends = [...tasks.values()].map(t => parseTime(t.time)).filter(v => v != null);
    return ends.length ? Math.max(...ends) : null;
  }

  function pushLater() {
    const plan = planPush();
    const names = ids => ids.map(id => `“${tasks.get(id).name}”`).join(', ');
    if (!plan.moves.size) {
      showStatus(plan.blocked.length
        ? `Nothing can move: ${names(plan.blocked)} ${plan.blocked.length === 1 ? 'is' : 'are'} locked`
        : 'No conflicts that moving moments later would fix');
      return;
    }
    const before = planEnd();
    plan.moves.forEach((m, id) => {
      const t = tasks.get(id);
      t.time = m.time;
      renderTask(t);
    });
    changed();
    const after = planEnd(), n = plan.moves.size;
    let msg = `Moved ${n} moment${n === 1 ? '' : 's'} later`;
    if (after != null && before != null && after > before) {
      msg += `; the last moment is now ${displayValue(formatTime(after))}, ${formatDuration(durationValue(after - before)).long} later`;
    }
    if (plan.blocked.length) msg += `. Still in conflict (locked): ${names(plan.blocked)}`;
    showStatus(msg, { action: { label: 'Undo', run: undo } });
  }
  $('#resolve').on('click', pushLater);

  // After an edit that creates new conflicts, offer to push the later moments.
  let conflictKeys = new Set();
  function checkNewConflicts(offer) {
    const now = new Set(edges.filter(e => e.conflict).map(e => e.from + '>' + e.to));
    const fresh = [...now].some(k => !conflictKeys.has(k));
    conflictKeys = now;
    if (!offer || !fresh) return;
    const plan = planPush();
    if (!plan.moves.size) return;
    const n = plan.moves.size;
    showStatus(`${n} later moment${n === 1 ? ' is' : 's are'} now too early.`,
      { action: { label: 'Push later', run: pushLater } });
  }

  // ---------------------------------------------------------------- auto-schedule
  // Fill in every missing time, as early as the dependencies allow: a moment
  // comes at the latest of the moments before it, plus any wait (or at `from`
  // when nothing comes before it). Times already set are kept, even when they
  // conflict. Returns the changes (id -> {time}) and how many moments couldn't
  // be placed (they need `from`).
  function planSchedule(from) {
    const changes = new Map(), timeOf = new Map();
    let unplaced = 0;
    topoOrder().forEach(id => {
      const t = tasks.get(id);
      let s = parseTime(t.time);
      if (t.locked) { if (s != null) timeOf.set(id, s); else unplaced++; return; }   // never changed
      if (s == null) {
        const ends = edges.filter(x => x.to === id).map(x => timeOf.has(x.from) ? timeOf.get(x.from) + minGap(x) : null);
        if (ends.some(v => v == null)) s = null;           // something before it couldn't be placed
        else if (ends.length) s = Math.max(...ends);
        else s = from;
        if (s != null) changes.set(id, { time: formatTime(s) });
      }
      if (s == null) unplaced++;
      else timeOf.set(id, s);
    });
    return { changes, unplaced };
  }

  function today() {
    const d = new Date();
    const day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
    return hourMode ? day * MIN_PER_DAY + 9 * 60 : day;     // 09:00 in hours
  }

  async function autoSchedule() {
    if (!tasks.size) { showStatus('Add some moments first'); return; }
    let plan = planSchedule(null);
    if (plan.unplaced) {
      // Some moments come after nothing dated: ask where the plan starts.
      const known = [...tasks.values()].map(t => parseTime(t.time)).filter(v => v != null);
      const answer = await askDate({
        title: 'Auto-schedule', confirm: 'Schedule',
        value: formatTime(known.length ? Math.min(...known) : today()),
        text: 'Moments without a time are placed as early as the moments before them allow, starting from this ' +
              (hourMode ? 'time' : 'date') + '. Times you have set are kept.',
      });
      if (answer == null) return;
      plan = planSchedule(parseTime(answer));
    }
    if (!plan.changes.size) { showStatus('Nothing to schedule: every moment already has its time'); return; }
    plan.changes.forEach((c, id) => {
      const t = tasks.get(id);
      Object.assign(t, c);
      renderTask(t);
    });
    changed();
    const n = plan.changes.size;
    showStatus(`Scheduled ${n} moment${n === 1 ? '' : 's'}. Undo takes it back.`);
  }
  $('#auto-schedule').on('click', autoSchedule);

  // Set a moment's time. Stored in one form: "2026-11-15" (days),
  // "2026-11-15T09:30" (hours, no seconds).
  function setTiming(t, value) {
    const n = parseTime(value);
    t.time = value === '' ? null : n != null ? formatTime(n) : value;
    renderTask(t);
    changed();
  }

  function clearTiming() {
    const t = tasks.get(selectedId);
    if (!t) return;
    t.time = null;
    renderTask(t);
    changed();
  }
  $props.on('click', '.clear', function (e) {
    e.preventDefault();   // don't let the label move focus to its field
    clearTiming();
  });

  // Delete moments: the picked boxes, or the one in the properties panel (a
  // folded phase's box stands for all its moments). When arcs run through the
  // deleted moments, ask whether to delete those arcs too or to reconnect around
  // them: each moment before them then leads straight to each one after them.
  async function deleteBoxes(ids) {
    const ms = new Set();
    ids.forEach(id => membersOf(id).forEach(m => { if (tasks.has(m)) ms.add(m); }));
    if (!ms.size) return;
    const names = [...ms].map(id => `“${tasks.get(id).name}”`);
    const title = ms.size === 1 ? `Delete ${names[0]}?` : `Delete ${ms.size} moments?`;
    const list = ms.size === 1 ? '' : (names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` :
      `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`) + '. ';
    const bridges = bridgeArcs(ms);
    let reconnect = false;
    if (bridges.length) {
      const choice = await askDelete({ title,
        text: list + `Arcs run through ${ms.size === 1 ? 'it' : 'them'}. Delete those arcs too, or reconnect around ` +
              `${ms.size === 1 ? 'it' : 'them'}: the moments before then lead straight to the moments after ` +
              `(${bridges.length === 1 ? 'one new arc' : `${bridges.length} new arcs`}, keeping any waits). Undo brings everything back.` });
      if (!choice) return;
      reconnect = choice === 'reconnect';
    } else if (!await confirmAction({ title, confirm: 'Delete', danger: true,
      text: list + ([...ms].some(hasEdges) ? 'Their arcs are removed too. ' : '') + 'Undo brings it back.' })) return;
    if ([...ms].some(id => !tasks.has(id))) return;   // changed while asking
    if (selectedId && ms.has(selectedId)) closeProps();
    if (pending) cancelPending();
    clearPicks();
    edges.filter(e => ms.has(e.from) || ms.has(e.to)).forEach(e => e.el.remove());
    edges = edges.filter(e => !ms.has(e.from) && !ms.has(e.to));
    orderHints = orderHints.filter(([a, b]) => !ms.has(a) && !ms.has(b));
    ms.forEach(id => { tasks.get(id).$el.remove(); tasks.delete(id); });
    if (reconnect) bridges.forEach(b => addEdge(b.from, b.to, b.wait));
    if (!tasks.size) $empty.show();
    changed();
    showStatus((ms.size === 1 ? `Deleted ${names[0]}` : `Deleted ${ms.size} moments`) +
      (reconnect ? `, reconnected with ${bridges.length === 1 ? 'one arc' : `${bridges.length} arcs`}` : ''),
      { action: { label: 'Undo', run: undo } });
  }
  // The arcs that reconnect around the moments ms: from each moment with an
  // arc into ms to each moment that ms leads out to, with the longest total wait
  // along the way (so no moment may come earlier than before). Arcs that are
  // already there are left out.
  function bridgeArcs(ms) {
    const memo = new Map();   // moment in ms -> Map(moment after ms -> longest wait to it)
    const outFrom = d => {
      if (memo.has(d)) return memo.get(d);
      const m = new Map();
      memo.set(d, m);
      const put = (s, w) => { if (!m.has(s) || m.get(s) < w) m.set(s, w); };
      edges.filter(e => e.from === d).forEach(e => {
        if (!ms.has(e.to)) put(e.to, waitOf(e));
        else outFrom(e.to).forEach((w, s) => put(s, w + waitOf(e)));
      });
      return m;
    };
    const best = new Map();   // "p s" -> {from, to, w}
    edges.filter(e => !ms.has(e.from) && ms.has(e.to)).forEach(e => {
      outFrom(e.to).forEach((w, s) => {
        const k = e.from + ' ' + s, total = w + waitOf(e);
        if (!best.has(k) || best.get(k).w < total) best.set(k, { from: e.from, to: s, w: total });
      });
    });
    const plain = parseDuration(graphWait) ?? 0;
    return [...best.values()]
      .filter(b => !edges.some(e => e.from === b.from && e.to === b.to))
      .map(b => ({ from: b.from, to: b.to, wait: b.w === plain ? null : durationValue(b.w) }));
  }

  let phaseOpenTimer = null;
  const PHASE_OPEN_DELAY = 250;
  $world.on('click', '.task', function (e) {
    if (suppressClick || $(e.target).closest('.conn, [contenteditable]').length) return;
    const id = $(this).attr('data-id');
    // Shift/⌘/Ctrl-click picks a box for a phase; while boxes are picked, a plain click (or tap) does too.
    if (e.shiftKey || e.metaKey || e.ctrlKey || picked.size) { clearTimeout(phaseOpenTimer); togglePick(id); return; }
    if (folds.has(id)) {
      // Open a folded phase after a moment's pause, so that a double-click can
      // rename it instead (the second click cancels the opening).
      clearTimeout(phaseOpenTimer);
      if (e.detail <= 1) phaseOpenTimer = setTimeout(() => expandFold(id), PHASE_OPEN_DELAY);
      return;
    }
    openProps(id);
  });
  // An open phase's frame: ▾ folds it back, × removes the phase.
  $world.on('click', '.phase-fold', function (e) {
    e.stopPropagation();
    if (!suppressClick) foldPhase($(this).closest('.phase-frame').attr('data-phase'));
  });
  $world.on('click', '.phase-remove', function (e) {
    e.stopPropagation();
    if (!suppressClick) removePhase($(this).closest('.phase-frame').attr('data-phase'));
  });
  // Names edited in place: double-click a moment's name in its box, or a
  // phase's name on its frame. Enter or leaving it keeps the new name, Esc puts
  // the old one back, and so does an empty name. (A single click on a box
  // opens the properties panel, as before.)
  function startNameEdit(el, name, save) {
    if (nameEdit) endNameEdit(true);
    el.textContent = name;   // a moment's name without its note and lock icons
    try { el.contentEditable = 'plaintext-only'; } catch (_) { el.contentEditable = 'true'; }
    $(el).addClass('editing');
    nameEdit = { el, name, save };
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function endNameEdit(keep) {
    if (!nameEdit) return;
    const { el, name, save } = nameEdit;
    nameEdit = null;
    const v = el.textContent.replace(/\s+/g, ' ').trim();
    el.removeAttribute('contenteditable');
    $(el).removeClass('editing');
    save(keep && v && v !== name ? v : null);   // null: redraw with the old name
    focusInput();
  }
  $world.on('dblclick', '.task:not(.fold) .name', function () {
    const t = tasks.get($(this).closest('.task').attr('data-id'));
    if (!t || picked.size) return;
    startNameEdit(this, t.name, v => {
      if (v && tasks.has(t.id)) { t.name = v; renderTask(t); changed(); }
      else renderTask(t);   // the old name, with its icons back
    });
  });
  // A phase: the name on its frame (open), or in its box (folded).
  $world.on('dblclick', '.phase-name, .task.fold .name', function () {
    clearTimeout(phaseOpenTimer);
    const f = folds.get($(this).closest('.phase-frame').attr('data-phase') || $(this).closest('.task').attr('data-id'));
    if (f && !picked.size) startNameEdit(this, f.name, phaseNameSaver(f));
  });
  function phaseNameSaver(f) {
    return v => {
      if (v && folds.has(f.id)) {
        f.name = v;
        renderFold(f);
        changed();
        showStatus(`Renamed the phase “${v}”`);
      } else if (folds.has(f.id)) {
        renderFold(f);
      }
    };
  }
  $world.on('keydown', '[contenteditable]', e => {
    e.stopPropagation();   // keep the editor's own keys (!, <, /, Esc, undo…) out of it
    if (e.key === 'Enter') { e.preventDefault(); endNameEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endNameEdit(false); }
  });
  $world.on('focusout', '[contenteditable]', () => endNameEdit(true));

  $('#p-name').on('input', function () {
    const t = tasks.get(selectedId), v = this.value.trim();
    if (!t || !v) return;
    t.name = v;
    renderTask(t);
    changed({ coalesce: 'name:' + t.id });
  }).on('blur', fillProps);   // restores the name if the field was left empty
  $('#p-locked').on('change', function () {
    const t = tasks.get(selectedId);
    if (!t) return;
    t.locked = this.checked;
    renderTask(t);   // the box shows a lock icon
    changed();
  });
  $('#p-notes').on('input', function () {
    const t = tasks.get(selectedId);
    if (!t) return;
    t.notes = this.value;
    renderTask(t);   // the box shows a notes icon when there are notes
    changed({ coalesce: 'notes:' + t.id });
  });
  // The time. Chrome reports every keystroke in a date field as a change
  // (typing a year passes through 0002, 0020, 0202…), so while the field has
  // focus the value is applied after a pause; leaving the field, Enter, Save,
  // closing the panel or picking another moment apply it at once.
  const dateEdits = new Map();   // input id -> {timer, id: task id}
  function commitDate(el) {
    const pend = dateEdits.get(el.id);
    if (!pend) return;
    clearTimeout(pend.timer);
    dateEdits.delete(el.id);
    const t = tasks.get(pend.id);
    if (!t || el.value === isoOrEmpty(t.time)) return;   // gone, or unchanged
    setTiming(t, el.value);
  }
  function flushDates() { commitDate(document.getElementById('p-time')); }
  $('#p-time').on('change', function () {
    if (!selectedId) return;
    const pend = dateEdits.get(this.id);
    if (pend) clearTimeout(pend.timer);
    dateEdits.set(this.id, { id: selectedId, timer: setTimeout(() => commitDate(this), 800) });
    if (document.activeElement !== this) commitDate(this);
  }).on('blur', function () { commitDate(this); });
  $props.on('keydown', 'input', e => {
    if (e.key === 'Enter') { $(e.target).trigger('change'); closeProps(); }
  });
  $('#props-close').on('click', closeProps);
  $('#p-accept').on('click', acceptSuggestion);
  $('#p-delete').on('click', () => deleteBoxes([selectedId]));
  // Keep the field being edited focused when pressing Save / Delete: blurring it
  // first would apply it and re-fill the panel, which can move the button away
  // from under the pointer before the click lands.
  $props.find('.prop-actions button').on('mousedown', e => e.preventDefault());
  $('#p-save').on('click', () => {
    // Commit the field being edited (date/number inputs only fire change on blur), then close.
    const el = document.activeElement;
    if (el && $props[0].contains(el) && $(el).is('input, textarea')) $(el).trigger('change');
    closeProps();
  });
  $(document).on('keydown', e => {
    if (e.key === 'Escape' && selectedId && $help.prop('hidden')) closeProps();
  });

  // ---------------------------------------------------------------- pointer input
  // Pointer events cover mouse, touch and pen alike. One pointer on the
  // background pans, one on a box without arcs moves it, two fingers pinch-zoom.
  const pointers = new Map();   // pointerId -> {x, y} for pointers down on the canvas
  let boxDrag = null;           // moving a box
  let drag = null;              // panning
  let pinch = null;             // two-finger zoom
  let connDrag = null;          // dragging a new arc out of a connector
  let longPress = null;         // {timer, id, x, y}: a finger held on a box picks it
  const LONG_PRESS = 500;
  function cancelLongPress() { if (longPress) { clearTimeout(longPress.timer); longPress = null; } }

  // ---- dragging an arc: from a connector to any part of another box
  function worldPoint(e) {
    const r = $canvas[0].getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  }
  // The task the arc would connect to with the pointer at (clientX, clientY), if it can.
  function dropTarget(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeId = el && $(el).closest('#world .task').attr('data-id');
    if (!nodeId || nodeId === nodeOf(pending.id)) return null;
    const id = connTask(nodeId, pending.side === 'in' ? 'out' : 'in');
    const c = candidateEdge(id);
    return { id, nodeId, problem: arcProblem(c.from, c.to) };
  }
  function moveConnDrag(e) {
    const own = nodeObj(nodeOf(pending.id));
    const t = dropTarget(e), target = t && !t.problem ? t : null;
    $world.find('.task.drop-target').removeClass('drop-target');
    let other;
    if (target) {
      other = nodeObj(target.nodeId);
      other.$el.addClass('drop-target');
    } else {   // a zero-size box at the pointer, positioned so the arc ends (or starts) there
      const p = worldPoint(e), out = pending.side === 'out';
      other = { x: p.x + (out && !vertical ? ARROW_GAP : 0), y: p.y + (out && vertical ? ARROW_GAP : 0), w: 0, h: 0, cy: 0 };
    }
    const d = pending.side === 'out' ? edgePath(own, other) : edgePath(other, own);
    connDrag.el.querySelector('.line').setAttribute('d', d);
    connDrag.target = t;
  }
  function endConnDrag(e, drop) {
    const { el, target } = connDrag;
    connDrag = null;
    el.remove();
    $world.find('.task.drop-target').removeClass('drop-target');
    $canvas.removeClass('linking');
    if (drop && target && !target.problem) { completePending(target.id); return; }
    cancelPending();
    if (drop && target) showStatus(target.problem, { error: true });   // e.g. it would make a cycle
  }

  function pointerPair() {
    const [a, b] = [...pointers.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  }

  function snapBoxBack(t, x0, y0) {
    const x1 = t.x, y1 = t.y;
    freeMoving = t.id;
    $({ s: 0 }).animate({ s: 1 }, {
      duration: 250,
      step(s) {
        t.x = x1 + (x0 - x1) * s;
        t.y = y1 + (y0 - y1) * s;
        t.$el.css({ left: t.x, top: t.y });
        drawEdges();
      },
      complete() { if (freeMoving === t.id) { freeMoving = null; drawEdges(); } },   // back where graphviz put it
    });
  }

  $canvas.on('pointerdown', ev => {
    const e = ev.originalEvent;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A phase's label, and a name being edited, handle their own pointer input.
    if ($(e.target).closest('.phase-label, [contenteditable]').length) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      cancelLongPress();
      // Second finger: switch to pinch-zoom; abandon any pan, box move or new arc.
      if (connDrag && connDrag.moved) endConnDrag(e, false);
      connDrag = null;
      if (boxDrag) {
        const { t, x0, y0, moved } = boxDrag;
        t.$el.removeClass('dragging drag-invalid');
        if (moved) snapBoxBack(t, x0, y0);
        boxDrag = null;
      }
      drag = null;
      if (viewTween) viewTween.stop(true, true);
      const p = pointerPair();
      pinch = { ...p, view0: { ...view } };
      userMoved = true;
      return;
    }
    if (pointers.size > 2) return;

    const $conn = $(e.target).closest('.conn');
    if ($conn.length) {   // a click is handled by the click handler; a drag draws a new arc
      const side = $conn.hasClass('conn-in') ? 'in' : 'out';
      connDrag = { id: connTask($conn.closest('.task').attr('data-id'), side), side, mx: e.clientX, my: e.clientY, moved: false };
      return;
    }
    if ($(e.target).closest('.edge').length) return;   // handled by its click handler
    const $task = $(e.target).closest('.task');
    if ($task.length && e.pointerType !== 'mouse') {
      // Press and hold (touch or pen): pick the box for a phase.
      const id = $task.attr('data-id');
      longPress = { id, x: e.clientX, y: e.clientY, fired: false, timer: setTimeout(() => {
        if (!longPress || boxDrag && boxDrag.moved) return;
        longPress.fired = true;
        boxDrag = null;
        clearTimeout(phaseOpenTimer);
        if (!picked.has(id)) togglePick(id);
        if (navigator.vibrate) navigator.vibrate(15);
      }, LONG_PRESS) };
    }
    if ($task.length) {
      const t = tasks.get($task.attr('data-id'));
      if (!t) return;   // a folded group: clicking it opens it
      // Boxes without arcs move freely; connected ones slide along their rank to reorder it.
      const rank = !$task.hasClass('movable');
      if (tween) tween.stop(true, true);                       // finish any layout animation first
      boxDrag = { t, rank, mx: e.clientX, my: e.clientY, x0: t.x, y0: t.y, moved: false, invalid: false };
      return;
    }
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  });

  $(document).on('pointermove', ev => {
    const e = ev.originalEvent;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (longPress && !longPress.fired && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > 8) cancelLongPress();

    if (pinch && pointers.size >= 2) {
      // Keep the point under the fingers' midpoint fixed while scaling.
      const p = pointerPair(), v0 = pinch.view0;
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v0.k * p.dist / pinch.dist));
      const wx = (pinch.mid.x - v0.x) / v0.k, wy = (pinch.mid.y - v0.y) / v0.k;
      view.k = k;
      view.x = p.mid.x - wx * k;
      view.y = p.mid.y - wy * k;
      applyView();
      return;
    }

    if (connDrag) {
      if (!connDrag.moved) {
        if (Math.hypot(e.clientX - connDrag.mx, e.clientY - connDrag.my) < 4) return;
        connDrag.moved = true;
        startPending(connDrag.id, connDrag.side);
        showStatus('Drop the arc on another moment (Esc to cancel)', { sticky: true });
        const g = document.createElementNS(SVGNS, 'g');
        g.setAttribute('class', 'edge drag-edge');
        const line = document.createElementNS(SVGNS, 'path');
        line.setAttribute('class', 'line');
        line.setAttribute('marker-end', 'url(#arrow)');
        g.appendChild(line);
        $edgeLayer[0].appendChild(g);
        connDrag.el = g;
        $canvas.addClass('linking');
      }
      moveConnDrag(e);
      return;
    }

    if (boxDrag) {
      const dx = (e.clientX - boxDrag.mx) / view.k, dy = (e.clientY - boxDrag.my) / view.k;
      if (!boxDrag.moved && Math.hypot(dx, dy) * view.k < 4) return;
      const t = boxDrag.t;
      boxDrag.moved = true;
      if (boxDrag.rank) {
        freeMoving = t.id;
        if (vertical) t.x = boxDrag.x0 + dx; else t.y = boxDrag.y0 + dy;
        t.$el.css({ left: t.x, top: t.y }).addClass('dragging');
        drawEdges();
        return;
      }
      t.x = boxDrag.x0 + dx;
      t.y = boxDrag.y0 + dy;
      const others = shownNodes().filter(o => o !== t).map(o => rectAt(o, o));
      boxDrag.invalid = overlapsAny(rectAt(t, t), others);
      t.$el.css({ left: t.x, top: t.y }).addClass('dragging').toggleClass('drag-invalid', boxDrag.invalid);
      return;
    }

    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      userMoved = true;
      $canvas.addClass('panning');
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      applyView();
    }
  });

  $(document).on('pointerup pointercancel', ev => {
    const e = ev.originalEvent;
    if (!pointers.delete(e.pointerId)) return;
    if (longPress) {
      if (longPress.fired) {   // the lift after a long press is not a tap on the box
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
      cancelLongPress();
    }

    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        // Carry on panning with the remaining finger; it doesn't count as a tap.
        const rest = [...pointers.values()][0];
        drag = rest ? { x: rest.x, y: rest.y, vx: view.x, vy: view.y, moved: true } : null;
      }
      return;
    }

    if (connDrag) {
      if (connDrag.moved) {
        suppressClick = true;                      // not a click on the connector or the box
        setTimeout(() => { suppressClick = false; }, 0);
        endConnDrag(e, e.type === 'pointerup');
      }
      connDrag = null;
      return;
    }

    if (boxDrag) {
      const { t, moved, invalid, x0, y0, rank } = boxDrag;
      boxDrag = null;
      t.$el.removeClass('dragging drag-invalid');
      if (!moved) return;
      suppressClick = true;                        // a drag is not a click on the box
      setTimeout(() => { suppressClick = false; }, 0);
      if (rank) {
        if (e.type !== 'pointercancel' && reorderRank(t, { x: x0, y: y0, w: t.w, cy: t.cy })) changed();
        else snapBoxBack(t, x0, y0);
        return;
      }
      if (invalid || e.type === 'pointercancel') {
        // Not allowed on top of another box: slide back to where it was.
        if (invalid) showStatus('A box can’t be placed on top of another box', { error: true });
        snapBoxBack(t, x0, y0);
        return;
      }
      t.pinned = { x: t.x, y: t.y };
      changed();
      return;
    }

    if (drag && !drag.moved && e.type === 'pointerup') { cancelPending(); closeProps(); clearPicks(); }   // tap on the background
    drag = null;
    $canvas.removeClass('panning');
  });

  // Wheel / two-finger scroll pans; Ctrl/⌘ + wheel or pinch zooms around the cursor.
  $canvas[0].addEventListener('wheel', e => {
    e.preventDefault();
    userMoved = true;
    if (viewTween) viewTween.stop(true, true);
    if (e.ctrlKey || e.metaKey) {
      const r = $canvas[0].getBoundingClientRect();
      Object.assign(view, zoomedView(view.k * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top));
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
    }
    applyView();
  }, { passive: false });

  // A held finger is picking a box, not asking for the browser's menu.
  $canvas.on('contextmenu', ev => { if (longPress || ev.originalEvent.pointerType !== 'mouse' && $(ev.target).closest('.task').length) ev.preventDefault(); });

  $(window).on('resize', () => {
    if (!userMoved && tasks.size) { Object.assign(view, fitView(currentBoxes())); applyView(); }
  });

  // ---------------------------------------------------------------- share links
  // The whole graph travels in the URL fragment (#g=…), compressed. The fragment
  // is never sent to the server. Format: one letter for the encoding, then base64url:
  //   z = deflate-raw compressed JSON, j = plain JSON (browsers without CompressionStream).
  function toB64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  }
  async function pipeBytes(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  }

  async function encodeGraph(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    if (window.CompressionStream) return 'z' + toB64url(await pipeBytes(bytes, new CompressionStream('deflate-raw')));
    return 'j' + toB64url(bytes);
  }

  async function decodeGraph(code) {
    let bytes = fromB64url(code.slice(1));
    if (code[0] === 'z') {
      if (!window.DecompressionStream) throw new Error('this browser cannot read compressed links');
      bytes = await pipeBytes(bytes, new DecompressionStream('deflate-raw'));
    } else if (code[0] !== 'j') {
      throw new Error('unknown link format');
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function shareLink() {
    if (!tasks.size) { showStatus('Add some moments first'); return; }
    let url;
    try {
      url = location.origin + location.pathname + location.search + '#g=' + await encodeGraph(serialize());
    } catch (err) {
      showStatus('Could not create the link: ' + err.message, { error: true });
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      showStatus(`Link copied to the clipboard (${(url.length / 1024).toFixed(1)} KB)`);
    } catch (_) {
      showLink(url);   // clipboard not available (e.g. plain http)
    }
  }

  // Open a graph from #g=… in the address bar, then remove it so that later
  // reloads show the (autosaved) edits instead of the original link.
  async function openFromHash() {
    const m = /^#g=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    let data;
    try {
      data = await decodeGraph(m[1]);
    } catch (err) {
      showStatus('Could not open the shared link: ' + err.message, { error: true });
      return;
    }
    if (tasks.size && !await confirmAction({
      title: `Open the shared graph (${(data.tasks || []).length} moments)?`, confirm: 'Open',
      text: `It replaces the graph you have here (${tasks.size} moments). Save that one first if you want to keep it.`,
    })) return;
    try {
      const skipped = loadGraph(data);
      fileHandle = null;
      setFileName(null);
      showStatus('Opened shared graph' + (skipped ? ` (${skipped} invalid items skipped)` : ''));
    } catch (err) {
      showStatus('Could not open the shared link: ' + err.message, { error: true });
    }
  }

  $('#share').on('click', shareLink);
  $(window).on('hashchange', openFromHash);   // a share link pasted into this tab

  setVertical(vertical);
  setHourMode(hourMode);
  setFileName(fileName);
  applyView();

  // Restore the autosaved graph, if any.
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) loadGraph(JSON.parse(saved));
  } catch (err) {
    console.warn('Could not restore autosaved graph', err);
  }
  if (undoHistory.index < 0) recordHistory(saveLocal());   // starting point for undo
  openFromHash();

  focusInput();
});
