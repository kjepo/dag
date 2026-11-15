/* Task DAG editor — jQuery + Graphviz (viz.js) */
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
  const tasks = new Map();   // id -> {id, name, start, duration, end, x, y, w, h, o, $el}
  let edges = [];            // {from, to, el}   (from's right connector -> to's left connector)
  let nextId = 1;
  let pending = null;        // {id, side: 'in'|'out'} — the selected (black) connector
  // Box order the user chose within a column (row, when vertical): pairs [a, b]
  // meaning a comes before b (above it; left of it when vertical).
  let orderHints = [];
  const rankOf = new Map();  // id -> rank (column/row) key from the last layout

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

  // A task's time span in minutes, end exclusive (in day mode the end day counts in full).
  function taskSpan(t) {
    let s = parseTime(t.start) ?? parseTime(t.end);
    let e = parseTime(t.end) ?? parseTime(t.start);
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
      const spans = ids.map(id => taskSpan(tasks.get(id))).filter(Boolean);
      if (!spans.length) return;                      // no dated task in this column
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
        const t = tasks.get(id);
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

  // A start or end value in words: "Jul 1" (days), "Jul 1 09:30" (hours).
  function displayValue(value) {
    const n = parseTime(value);
    if (n == null) return String(value);
    return hourMode ? `${shortDate(Math.floor(n / MIN_PER_DAY))} ${clockTime(n)}` : shortDate(n);
  }
  // How a start or end shows in a box: the date (days), or the time with the date
  // underneath when the graph spans more than one date (hours).
  function formatTimeField(value) {
    const n = parseTime(value);
    if (n == null) return { short: String(value), long: String(value) };
    if (!hourMode) return { short: shortDate(n), long: fullDate(n) };
    const day = Math.floor(n / MIN_PER_DAY);
    return { short: clockTime(n), sub: showDates ? shortDate(day) : null, long: `${fullDate(day)}, ${clockTime(n)}` };
  }

  // Days: whole days, counted inclusively (same start and end = 1 day), shown
  // as "5d", "3w", "3w 1d". Hours: minutes, end exclusive, shown as "45m",
  // "2h 30m", "1d 4h". Spelled out in the tooltip.
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
  // Exact duration for the properties field: days as a number, hours as "1d 2h 30m".
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

  // With both ends known, the duration follows from them.
  function derivedDuration(start, end) {
    const s = parseTime(start), e = parseTime(end);
    return s != null && e != null && e >= s ? durationValue(e - s + INCL()) : null;
  }

  function addTask(name) {
    createTask({ id: 't' + nextId++, name });
    if (pending) refreshConnectors();
    changed();
  }

  const NOTE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M3 1.5h7l3 3v10H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M5.5 7.5h5M5.5 10h5M5.5 12.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  const LOCK_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/>' +
    '<path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  // (Re)draw a box's contents and re-measure it (the name may wrap differently).
  // A task whose start and end are both set.
  function isDated(t) { return !!(t.start && t.end); }

  function renderTask(t) {
    const hasNotes = !!(t.notes && t.notes.trim());
    t.$el.find('.name').text(t.name)
      .append(t.locked ? $('<span class="lock-icon" aria-label="Locked" title="Locked: never moved automatically">').html(LOCK_ICON) : null)
      .append(hasNotes ? $('<span class="note-icon" aria-label="Has notes">').html(NOTE_ICON) : null)
      .attr('title', hasNotes ? t.notes : null);
    t.$el.toggleClass('dated', isDated(t));   // thicker border; changes the size, so before measuring
    t.$el.find('.fields').empty().append(
      field('Start', t.start, formatTimeField),
      field('Duration', t.duration, formatDuration),
      field('End', t.end, formatTimeField)
    );
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

  function createTask({ id, name, start = null, duration = null, end = null, notes = '', locked = false }) {
    duration = derivedDuration(start, end) ?? duration;
    const t = { id, name, start, duration, end, notes: typeof notes === 'string' ? notes : '', locked: locked === true, x: 0, y: 0, o: 0 };
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
    if (from === to) return 'A task cannot depend on itself';
    if (edges.some(e => e.from === from && e.to === to)) return 'Those tasks are already connected';
    if (descendants(to).has(from)) return 'That connection would create a cycle';
    return null;
  }

  function addEdge(from, to) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'edge');
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = 'Click to remove';
    const hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('class', 'hit');
    const line = document.createElementNS(SVGNS, 'path');
    line.setAttribute('class', 'line');
    line.setAttribute('marker-end', 'url(#arrow)');
    g.append(title, hit, line);
    $edgeLayer[0].appendChild(g);
    const e = { from, to, el: g };
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
    const useSpline = splinesOn && e.spline && freeMoving !== e.from && freeMoving !== e.to;
    const d = useSpline ? splinePath(e.spline) : edgePath(tasks.get(e.from), tasks.get(e.to));
    for (const p of e.el.querySelectorAll('path')) p.setAttribute('d', d);
  }
  function drawEdges() { edges.forEach(e => { if (!e.hidden) drawEdge(e); }); }

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
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(v == null ? '' : String(v).trim());
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
  // Days count both the first and the last day; times run from start up to end.
  function INCL() { return hourMode ? 0 : 1; }
  // How soon a task may start after one it depends on ends: the next day (days),
  // the same minute (hours).
  function NEXT() { return hourMode ? 0 : 1; }

  // A task is in conflict when its own dates disagree, or when it is connected
  // to a task whose dates violate the dependency (the later task starts before
  // the earlier one ends; in days, it must start the day after).
  function updateConflicts() {
    const problems = new Map();
    tasks.forEach((t, id) => problems.set(id, []));

    tasks.forEach((t, id) => {
      const s = parseTime(t.start), e = parseTime(t.end);
      if (s != null && e != null && e < s) problems.get(id).push('Ends before it starts');
    });

    edges.forEach(edge => {
      const a = tasks.get(edge.from), b = tasks.get(edge.to);
      const aEnd = parseTime(a.end) ?? parseTime(a.start);
      const bStart = parseTime(b.start) ?? parseTime(b.end);
      edge.conflict = aEnd != null && bStart != null && bStart < aEnd + NEXT();
      edge.el.classList.toggle('conflict', edge.conflict);
      edge.el.querySelector('.line').setAttribute('marker-end', edge.conflict ? 'url(#arrow-conflict)' : 'url(#arrow)');
      if (edge.conflict) {
        const ends = displayValue(a.end || a.start), starts = displayValue(b.start || b.end);
        problems.get(b.id).push(hourMode || bStart < aEnd ? `Starts before “${a.name}” ends (${ends})`
                                                          : `Starts the same day “${a.name}” ends (${ends})`);
        problems.get(a.id).push(hourMode || bStart < aEnd ? `Ends after “${b.name}” starts (${starts})`
                                                          : `Ends the same day “${b.name}” starts (${starts})`);
      }
    });

    tasks.forEach((t, id) => {
      const list = problems.get(id);
      t.problems = list;
      t.$el.toggleClass('conflict', list.length > 0)
        .attr('title', list.length ? 'Date conflict:\n• ' + list.join('\n• ') : null);
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

  // Slack (total float): how far a task's end can move before it delays a task
  // that depends on it, or the end of the whole plan. Each task's times are its
  // own; missing ones are as early as its dependencies allow, plus its duration.
  // Returns { times: id -> {s, e, latestEnd, slack}, latestStart: id -> time }
  // for the tasks whose times can be worked out.
  function computeSlack() {
    const order = topoOrder();
    const preds = id => edges.filter(e => e.to === id).map(e => e.from);
    const succs = id => edges.filter(e => e.from === id).map(e => e.to);
    const times = new Map(), latestStart = new Map();
    order.forEach(id => {
      const t = tasks.get(id), d = parseDuration(t.duration);
      let s = parseTime(t.start), e = parseTime(t.end);
      if (s == null && e == null) {
        const ends = preds(id).map(p => times.get(p)).filter(Boolean).map(r => r.e);
        if (ends.length) s = Math.max(...ends) + NEXT();
      }
      if (e == null && s != null) e = d != null ? s + d - INCL() : s;
      if (s == null && e != null) s = d != null ? e - d + INCL() : e;
      if (s != null && e != null) times.set(id, { s, e });
    });
    if (!times.size) return { times, latestStart };
    const finish = Math.max(...[...times.values()].map(r => r.e));
    [...order].reverse().forEach(id => {
      const r = times.get(id);
      const after = succs(id).map(s => latestStart.get(s)).filter(v => v != null).map(v => v - NEXT());
      const lf = after.length ? Math.min(...after) : r ? finish : null;
      if (r) {
        r.latestEnd = lf;
        r.slack = lf - r.e;
        latestStart.set(id, lf - (r.e - r.s));
      } else if (lf != null) {
        latestStart.set(id, lf + NEXT());   // times unknown: pass the constraint on to the tasks before it
      }
    });
    return { times, latestStart };
  }

  function slackText(r) {
    const long = formatDuration(durationValue(Math.abs(r.slack))).long;
    const by = displayValue(formatTime(r.latestEnd));
    if (r.slack === 0) return 'Critical: any delay here delays what comes after it.';
    if (r.slack > 0) return `Slack: ${long}. It can end as late as ${by} without delaying anything.`;
    return `Behind by ${long}: it would have to end by ${by} for the later dates to hold.`;
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
    edges.forEach(e => {
      const a = times.get(e.from), b = times.get(e.to);
      // The arc that sets the latest end of a critical task.
      e.critical = !!(a && b && a.slack <= 0 && b.slack <= 0 && latestStart.get(e.to) - NEXT() === a.latestEnd);
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
      e.hidden = isTransitive(e);
      e.el.style.display = e.hidden ? 'none' : '';
    });
  }

  // ---------------------------------------------------------------- connecting
  // The edge that would be created by clicking the green connector on task `otherId`.
  function candidateEdge(otherId) {
    return pending.side === 'in'
      ? { from: otherId, to: pending.id }
      : { from: pending.id, to: otherId };
  }

  function startPending(id, side) {
    pending = { id, side };
    refreshConnectors();
    const name = tasks.get(id).name;
    const question = side === 'in'
      ? `which task must finish before “${name}”?`
      : `which task must wait for “${name}”?`;
    showStatus(`Pick a green connector: ${question} (Esc to cancel)`, { sticky: true });
  }

  function cancelPending() {
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
    tasks.get(pending.id).$el.find(own).addClass('active');
    tasks.forEach((t, id) => {
      if (id === pending.id) return;
      const e = candidateEdge(id);
      t.$el.find(other).addClass(edgeProblem(e.from, e.to) ? 'blocked' : 'available');
    });
  }

  // ---------------------------------------------------------------- layout
  // Height of the box padded (above or below) so that its divider is in the middle.
  function layoutHeight(t) { return 2 * Math.max(t.cy, t.h - t.cy); }

  // Order of boxes without arcs: undated tasks first, in the order they were
  // added, then tasks with both dates, by start, end and name.
  function looseOrder(list) {
    const undated = list.filter(t => !isDated(t));
    const dated = list.filter(isDated).sort((a, b) =>
      (parseTime(a.start) ?? 0) - (parseTime(b.start) ?? 0) ||
      (parseTime(a.end) ?? 0) - (parseTime(b.end) ?? 0) || a.name.localeCompare(b.name));
    return [...undated, ...dated];
  }

  // Depth of every connected task: 0 without predecessors, else 1 + the deepest predecessor.
  function earliestLevels() {
    const level = new Map();
    const preds = new Map();
    edges.forEach(e => { if (!preds.has(e.to)) preds.set(e.to, []); preds.get(e.to).push(e.from); });
    const depth = id => {
      if (level.has(id)) return level.get(id);
      level.set(id, 0);   // (the graph is acyclic; this only guards against surprises)
      const d = Math.max(-1, ...(preds.get(id) || []).map(depth)) + 1;
      level.set(id, d);
      return d;
    };
    tasks.forEach((t, id) => { if (hasEdges(id) && !t.pinned) depth(id); });
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
    const loose = [...tasks.values()].filter(t => !t.pinned && !hasEdges(t.id));
    const looseW = Math.max(0, ...loose.map(t => t.w));
    const looseH = Math.max(0, ...loose.map(t => vertical ? t.h : layoutHeight(t)));
    tasks.forEach(t => {
      if (t.pinned) return;   // placed by hand, not by graphviz
      // Horizontal: graphviz lines nodes up by their centres. Give each node a height
      // that is symmetric around the divider, so the dividers (where the arcs attach) line up.
      const isLoose = !hasEdges(t.id);
      const w = isLoose ? looseW : t.w;
      const h = isLoose ? looseH : vertical ? t.h : layoutHeight(t);
      lines.push(`  ${q(t.id)} [width=${(w / 72).toFixed(3)}, height=${(h / 72).toFixed(3)}];`);
    });
    edges.forEach(e => { if (!e.hidden) lines.push(`  ${q(e.from)} -> ${q(e.to)};`); });
    // Each task as early as its predecessors allow: same rank for all tasks at the
    // same depth (longest path from a task with no predecessors).
    const levels = new Map();
    earliestLevels().forEach((lvl, id) => {
      if (!levels.has(lvl)) levels.set(lvl, []);
      levels.get(lvl).push(q(id));
    });
    levels.forEach(ids => { if (ids.length > 1) lines.push(`  { rank=same; ${ids.join('; ')}; }`); });
    // The user's order within a rank: invisible arcs between boxes kept in the same rank.
    hints.forEach(([a, b]) => {
      const [x, y] = flatReversed[vertical ? 'v' : 'h'] ? [b, a] : [a, b];
      lines.push(`  { rank=same; ${q(x)} -> ${q(y)} [style=invis]; }`);
    });
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

  function hasEdges(id) { return edges.some(e => e.from === id || e.to === id); }

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
      if (!o.pos || !tasks.has(o.name)) return;
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
        const t = tasks.get(o.name);
        if (!t || !o.pos) return;
        const [cx, cy] = o.pos.split(',').map(Number);
        // graphviz y points up; horizontally the divider sits on the node centre
        targets[o.name] = { x: cx - t.w / 2, y: (H - cy) - (vertical ? t.h / 2 : t.cy) };
        if (!hasEdges(t.id)) slots.push({ cx, cy: H - cy });
        const key = Math.round(vertical ? H - cy : cx);
        if (!rankMap.has(key)) rankMap.set(key, []);
        rankMap.get(key).push(o.name);
      });
      // Graphviz doesn't keep the input order of unconnected boxes; put them in
      // order ourselves (top to bottom, or left to right when vertical).
      const loose = looseOrder([...tasks.values()].filter(t => targets[t.id] && !hasEdges(t.id)));
      slots.sort((a, b) => vertical ? a.cx - b.cx || a.cy - b.cy : a.cy - b.cy || a.cx - b.cx);
      loose.forEach((t, i) => {
        const c = slots[i];
        targets[t.id] = { x: c.cx - t.w / 2, y: c.cy - (vertical ? t.h / 2 : t.cy) };
      });
      buildLegend([...rankMap.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids));
      // Hand-placed boxes stay put, unless the new layout now covers them;
      // then they move to the nearest free spot.
      const placed = Object.keys(targets).map(id => rectAt(tasks.get(id), targets[id]));
      tasks.forEach(t => {
        if (!t.pinned) return;
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
    tasks.forEach((t, id) => {
      const p = (targets && targets[id]) || t;
      boxes.push({ x: p.x, y: p.y, w: t.w, h: t.h });
    });
    return boxes;
  }

  function animateTo(targets, routes = {}) {
    if (tween) tween.stop();
    splinesOn = false;
    freeMoving = null;
    edges.forEach(e => { e.spline = routes[`${e.from}>${e.to}`] || null; });

    const from = {};
    tasks.forEach((t, id) => {
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
    const v1 = userMoved ? null : fitView(currentBoxes(targets));
    const lerp = (a, b, s) => a + (b - a) * s;

    tween = $({ s: 0 }).animate({ s: 1 }, {
      duration: ANIM_MS,
      easing: 'swing',
      step(s) {
        for (const id in from) {
          const t = tasks.get(id), f = from[id], to = targets[id];
          t.x = lerp(f.x, to.x, s);
          t.y = lerp(f.y, to.y, s);
          t.o = lerp(f.o, 1, s);
          t.$el.css({ left: t.x, top: t.y, opacity: t.o });
        }
        if (v1 && !userMoved) {
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
  const STORAGE_KEY = 'task-dag-editor:v1';

  function serialize() {
    return {
      format: 'task-dag',
      version: 1,
      layout: vertical ? 'vertical' : 'horizontal',
      timeUnit: hourMode ? 'hour' : 'day',
      tasks: [...tasks.values()].map(t => ({
        id: t.id, name: t.name, start: t.start, duration: t.duration, end: t.end,
        ...(t.notes ? { notes: t.notes } : {}),
        ...(t.locked ? { locked: true } : {}),
        ...(t.pinned ? { pos: { x: Math.round(t.pinned.x), y: Math.round(t.pinned.y) } } : {}),
      })),
      edges: edges.map(e => ({ from: e.from, to: e.to })),
      ...(orderHints.length ? { order: orderHints.map(h => [...h]) } : {}),
    };
  }

  // Called after every edit: re-layout and autosave to the browser.
  // opts.coalesce: a key for edits that come in a stream (typing a name or notes);
  // quick successive edits with the same key become one undo step.
  function changed(opts = {}) {
    updateShowDates();
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
    const prev = new Map([...tasks].map(([id, t]) => [id, { x: t.x, y: t.y }]));
    if (pending) cancelPending();
    restoring = true;
    try { loadGraph(JSON.parse(json), { keepView: true, prev }); } finally { restoring = false; }
    undoHistory.lastKey = null;
    if (sel && tasks.has(sel)) openProps(sel);
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
    orderHints = [];
    nextId = 1;
    $empty.show();
  }

  // Replace the current graph with `data`. Throws on malformed input.
  // opts.keepView: undo/redo — keep the view, and slide boxes from opts.prev positions.
  function loadGraph(data, opts = {}) {
    if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.edges)) {
      throw new Error('Not a task graph file');
    }
    clearGraph();
    if (data.layout === 'vertical' || data.layout === 'horizontal') setVertical(data.layout === 'vertical');
    setHourMode(data.timeUnit === 'hour');   // files without it are in days
    let skipped = 0;
    data.tasks.forEach(t => {
      if (!t || typeof t.name !== 'string') { skipped++; return; }
      const id = typeof t.id === 'string' && /^t\d+$/.test(t.id) && !tasks.has(t.id) ? t.id : null;
      if (!id) { skipped++; return; }
      const task = createTask({ id, name: t.name, start: t.start, duration: t.duration, end: t.end, notes: t.notes, locked: t.locked });
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
      addEdge(e.from, e.to);
    });
    if (Array.isArray(data.order)) {
      orderHints = data.order.filter(h => Array.isArray(h) && h.length === 2 &&
        tasks.has(h[0]) && tasks.has(h[1]) && h[0] !== h[1]).map(h => [h[0], h[1]]);
    }
    if (!opts.keepView) {
      userMoved = false;
      initialView = true;   // show the loaded graph as large as fits, like the Fit button
    }
    changed({ quiet: true });
    return skipped;
  }

  // The name the graph was last opened or saved as; suggested the next time it's saved.
  const FILE_NAME_KEY = 'task-dag-editor:file-name';
  let fileName = null;
  try { fileName = localStorage.getItem(FILE_NAME_KEY); } catch (_) { /* storage unavailable */ }
  function setFileName(name) {
    fileName = name || null;
    document.title = fileName ? `${fileName} — Task DAG Editor` : 'Task DAG Editor';
    const project = fileName ? fileName.replace(/\.json$/i, '') : '';
    $input.attr('placeholder', project ? `New ${project} task… (Enter to add)` : 'New task… (Enter to add)');
    try {
      if (fileName) localStorage.setItem(FILE_NAME_KEY, fileName); else localStorage.removeItem(FILE_NAME_KEY);
    } catch (_) { /* storage unavailable */ }
  }

  // Chrome and Edge: the file last saved or opened, so Save can write to it again.
  let fileHandle = null;
  const FILE_TYPES = [{ description: 'Task graph', accept: { 'application/json': ['.json'] } }];

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
    const saved = () => showStatus(`Saved “${fileName}” (${tasks.size} tasks, ${edges.length} dependencies)`);
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
    const suggested = fileName || 'task-graph.json';
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
    const name = cleanName(answer) || 'task-graph.json';
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
    if (!$(e.target).closest('input, select, textarea, #props').length) e.preventDefault();
  });
  // Only with a mouse: on a phone, focusing the field would pop up the keyboard on every tap.
  $(document).on('pointerup', ev => {
    if (ev.originalEvent.pointerType === 'mouse' && !$(ev.target).closest('#props, .swal2-container').length) $input.trigger('focus');
  });

  // Either connector can start a connection; the opposite side of other boxes
  // then turns green. Clicking a green one completes the edge.
  $world.on('click', '.conn', function (e) {
    e.stopPropagation();
    const id = $(this).closest('.task').attr('data-id');
    const side = $(this).hasClass('conn-in') ? 'in' : 'out';

    if (pending && pending.side !== side && pending.id !== id) {
      const edge = candidateEdge(id);
      const problem = edgeProblem(edge.from, edge.to);
      if (problem) { showStatus(problem, { error: true }); return; }
      cancelPending();
      const implied = descendants(edge.from).has(edge.to);
      const added = addEdge(edge.from, edge.to);
      changed();
      if (added.conflict) {
        const a = tasks.get(edge.from), b = tasks.get(edge.to);
        showStatus(`Date conflict: “${b.name}” starts before “${a.name}” ends`, { error: true });
      } else if (implied) {
        showStatus(`“${tasks.get(edge.from).name}” already comes before “${tasks.get(edge.to).name}” through other tasks, so this arc is not drawn`);
      }
    } else if (pending && pending.id === id && pending.side === side) {
      cancelPending();
    } else {
      startPending(id, side);
    }
  });

  $edgeLayer.on('click', '.edge', function (e) {
    e.stopPropagation();
    const edge = edges.find(x => x.el === this);
    if (edge) removeEdge(edge);
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
    $('#p-start, #p-end').attr('type', v ? 'datetime-local' : 'date');
    $('#p-duration').attr(v ? { type: 'text', inputmode: 'text', placeholder: 'e.g. 2h 30m' }
                            : { type: 'number', inputmode: null, placeholder: null });
    $('#p-duration-label').text(v ? 'Duration' : 'Duration (days)');
  }

  // In hour mode, boxes show the date under the time when the graph covers more than one date.
  function updateShowDates() {
    let v = false;
    if (hourMode) {
      const days = new Set();
      tasks.forEach(t => [t.start, t.end].forEach(x => {
        const n = parseDateTime(x);
        if (n != null) days.add(Math.floor(n / MIN_PER_DAY));
      }));
      v = days.size > 1;
    }
    if (v === showDates) return;
    showDates = v;
    tasks.forEach(renderTask);
  }

  // Convert every task's times to the other unit. Days -> hours is exact
  // (Nov 14 – Nov 14 becomes Nov 14 00:00 – Nov 15 00:00); hours -> days drops
  // the time of day, so it asks first when there is any.
  async function switchTimeUnit(toHours) {
    const conv = [...tasks.values()].map(t => {
      if (toHours) {
        const s = parseDate(t.start), e = parseDate(t.end), d = parseDays(t.duration);
        return { t, lossy: false,
          start: s != null ? isoFromMinute(s * MIN_PER_DAY) : null,
          end: e != null ? isoFromMinute((e + 1) * MIN_PER_DAY) : null,
          duration: d != null ? `${d * MIN_PER_DAY}m` : null };
      }
      const s = parseDateTime(t.start), e = parseDateTime(t.end), d = parseMinutes(t.duration);
      const lossy = [s, e, d].some(n => n != null && n % MIN_PER_DAY !== 0);
      const sDay = s != null ? Math.floor(s / MIN_PER_DAY) : null;
      let eDay = null;
      if (e != null) {
        // The end is exclusive: a task ending at midnight ends the day before (unless it takes no time).
        eDay = s != null && e <= s ? Math.floor(e / MIN_PER_DAY) : Math.ceil(e / MIN_PER_DAY) - 1;
        if (sDay != null) eDay = Math.max(eDay, sDay);
      }
      return { t, lossy,
        start: sDay != null ? isoFromDay(sDay) : null,
        end: eDay != null ? isoFromDay(eDay) : null,
        duration: d != null ? `${Math.max(1, Math.ceil(d / MIN_PER_DAY))}d` : null };
    });
    const lossy = conv.filter(c => c.lossy).length;
    if (lossy && !await confirmAction({
      title: 'Switch to whole days?', confirm: 'Switch',
      text: `The times of day of ${lossy} task${lossy === 1 ? '' : 's'} will be rounded to whole days.`,
    })) return;
    setHourMode(toHours);
    conv.forEach(({ t, start, end, duration }) => {
      t.start = start; t.end = end;
      t.duration = derivedDuration(start, end) ?? duration;
    });
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
    cancelPending();
    selectedId = id;
    $world.find('.task.selected').removeClass('selected');
    tasks.get(id).$el.addClass('selected');
    $props.prop('hidden', false);
    fillProps();
  }

  function closeProps() {
    if (!selectedId) return;
    const t = tasks.get(selectedId);
    if (t) t.$el.removeClass('selected');
    selectedId = null;
    $props.prop('hidden', true);
    focusInput();
  }

  function depItem(task, edge) {
    return $('<li>').append(
      $('<button type="button" class="dep-name">').text(task.name).attr('title', 'Show this task')
        .on('click', () => openProps(task.id)),
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

    // Missing dates are pre-filled with suggestions from neighbouring tasks.
    const sug = suggestTiming(t);
    const startVal = isoOrEmpty(t.start) || sug.start || '';
    const endVal = isoOrEmpty(t.end) || sug.end || '';
    const sDay = parseTime(startVal), eDay = parseTime(endVal);
    const ownDays = parseDuration(t.duration);
    const sugDays = ownDays == null && sug.any && sDay != null && eDay != null && eDay >= sDay ? eDay - sDay + INCL() : null;
    set('#p-start', startVal);
    set('#p-end', endVal);
    set('#p-duration', ownDays ?? sugDays ?? '');
    if ($('#p-duration')[0] !== active && hourMode && (ownDays ?? sugDays) != null) $('#p-duration').val(durationInput(ownDays ?? sugDays));
    $('#p-start').toggleClass('suggested', !!sug.start);
    $('#p-end').toggleClass('suggested', !!sug.end);
    $('#p-duration').toggleClass('suggested', sugDays != null);
    $('#p-suggest').prop('hidden', !sug.any);
    $('#p-suggest-text').text(sug.reason);

    const both = parseTime(t.start) != null && parseTime(t.end) != null;
    const d = ownDays ?? sugDays;
    $('#p-duration-hint').text(
      (d != null ? formatDuration(durationValue(d)).long + '. ' : '') +
      (both ? `Calculated from the ${hourMode ? 'times' : 'dates'}; changing it moves the end.`
            : 'Set two of start, end and duration and the third is filled in.'));
    $('#p-locked').prop('checked', !!t.locked);
    $('#p-slack').prop('hidden', !t.slack).text(t.slack ? slackText(t.slack) : '')
      .toggleClass('critical', !!t.slack && t.slack.slack <= 0);

    // × buttons: only for values the task really has (not suggestions). The duration
    // follows from the dates when both are set, so clear one of those instead.
    $props.find('.clear[data-key="start"]').prop('hidden', !t.start);
    $props.find('.clear[data-key="end"]').prop('hidden', !t.end);
    $props.find('.clear[data-key="duration"]').prop('hidden', !t.duration || both);

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

  // Suggested dates for a task that lacks a start and/or end:
  //  - start: after the latest end among the tasks it depends on (the next day, in days);
  //  - end:   start + duration, or else the earliest start
  //           among the tasks that depend on it;
  //  - start from end - duration when nothing comes before it.
  function suggestTiming(t) {
    const preds = edges.filter(e => e.to === t.id).map(e => tasks.get(e.from));
    const succs = edges.filter(e => e.from === t.id).map(e => tasks.get(e.to));
    const predEnds = preds.map(p => parseTime(p.end) ?? parseTime(p.start)).filter(v => v != null);
    const succStarts = succs.map(s => parseTime(s.start) ?? parseTime(s.end)).filter(v => v != null);
    const d = parseDuration(t.duration);
    const s = parseTime(t.start), e = parseTime(t.end);
    const when = hourMode ? 'when' : 'the day';
    let sugS = null, sugE = null;
    const why = [];

    if (s == null && predEnds.length) {
      sugS = Math.max(...predEnds) + NEXT();
      why.push(hourMode ? 'start: when the tasks it depends on end' : 'start: the day after the tasks it depends on end');
    }
    if (e == null) {
      const S = s ?? sugS;
      if (S != null && d != null) { sugE = S + d - INCL(); why.push('end: start + duration'); }
      else if (succStarts.length) { sugE = Math.min(...succStarts) - NEXT(); why.push(hourMode ? 'end: when the tasks that need it start' : 'end: the day before the tasks that need it start'); }
    }
    if (s == null && sugS == null && d != null) {
      const E = e ?? sugE;
      if (E != null) { sugS = E - d + INCL(); why.push('start: end − duration'); }
    }
    return {
      start: sugS != null ? formatTime(sugS) : null,
      end: sugE != null ? formatTime(sugE) : null,
      any: sugS != null || sugE != null,
      reason: why.length ? 'Suggested ' + why.join('; ') + '.' : '',
    };
  }

  function acceptSuggestion() {
    const t = tasks.get(selectedId);
    if (!t) return;
    const sug = suggestTiming(t);
    if (sug.start) t.start = sug.start;
    if (sug.end) t.end = sug.end;
    t.duration = derivedDuration(t.start, t.end) ?? t.duration;
    renderTask(t);
    changed();
  }

  // ---------------------------------------------------------------- resolve conflicts
  // Move tasks that start too early (before a task they depend on ends, or in
  // days on that same day) later by just enough, keeping their duration; the
  // move carries on to the tasks after them. Locked tasks never move: they stay
  // in conflict and are reported. Own-date problems (end before start) are left.
  // Returns { moves: id -> {start, end}, shift: id -> amount, blocked: [ids] }.
  function planPush() {
    const cur = new Map([...tasks].map(([id, t]) => [id, { s: parseTime(t.start), e: parseTime(t.end) }]));
    const moves = new Map(), shift = new Map(), blocked = [];
    topoOrder().forEach(id => {
      const t = tasks.get(id), c = cur.get(id);
      const at = c.s ?? c.e;                           // where it starts, as conflicts see it
      if (at == null) return;
      const ends = edges.filter(x => x.to === id).map(x => { const p = cur.get(x.from); return p.e ?? p.s; })
        .filter(v => v != null);
      if (!ends.length) return;
      const need = Math.max(...ends) + NEXT() - at;
      if (need <= 0) return;
      if (t.locked) { blocked.push(id); return; }
      if (c.s != null) c.s += need;
      if (c.e != null) c.e += need;
      shift.set(id, need);
      moves.set(id, { start: c.s != null ? formatTime(c.s) : t.start, end: c.e != null ? formatTime(c.e) : t.end });
    });
    return { moves, shift, blocked };
  }

  function planEnd() {
    const ends = [...tasks.values()].map(t => parseTime(t.end) ?? parseTime(t.start)).filter(v => v != null);
    return ends.length ? Math.max(...ends) : null;
  }

  function pushLater() {
    const plan = planPush();
    const names = ids => ids.map(id => `“${tasks.get(id).name}”`).join(', ');
    if (!plan.moves.size) {
      showStatus(plan.blocked.length
        ? `Nothing can move: ${names(plan.blocked)} ${plan.blocked.length === 1 ? 'is' : 'are'} locked`
        : 'No conflicts that moving tasks later would fix');
      return;
    }
    const before = planEnd();
    plan.moves.forEach((m, id) => {
      const t = tasks.get(id);
      t.start = m.start; t.end = m.end;
      t.duration = derivedDuration(t.start, t.end) ?? t.duration;
      renderTask(t);
    });
    changed();
    const after = planEnd(), n = plan.moves.size;
    let msg = `Moved ${n} task${n === 1 ? '' : 's'} later`;
    if (after != null && before != null && after > before) {
      msg += `; the plan now ends ${displayValue(formatTime(after))}, ${formatDuration(durationValue(after - before)).long} later`;
    }
    if (plan.blocked.length) msg += `. Still in conflict (locked): ${names(plan.blocked)}`;
    showStatus(msg, { action: { label: 'Undo', run: undo } });
  }
  $('#resolve').on('click', pushLater);

  // After an edit that creates new conflicts, offer to push the later tasks.
  let conflictKeys = new Set();
  function checkNewConflicts(offer) {
    const now = new Set(edges.filter(e => e.conflict).map(e => e.from + '>' + e.to));
    const fresh = [...now].some(k => !conflictKeys.has(k));
    conflictKeys = now;
    if (!offer || !fresh) return;
    const plan = planPush();
    if (!plan.moves.size) return;
    const n = plan.moves.size;
    showStatus(`${n} later task${n === 1 ? '' : 's'} now start${n === 1 ? 's' : ''} too early.`,
      { action: { label: 'Push later', run: pushLater } });
  }

  // ---------------------------------------------------------------- auto-schedule
  // Fill in every missing start and end, as early as the dependencies allow: a
  // task starts when the last task it depends on ends (or at `from` when it
  // depends on nothing), and ends after its duration. Times already set are kept,
  // even when they conflict. Returns the changes (id -> {start?, end?}) and how
  // many tasks couldn't be placed (they need `from`).
  function planSchedule(from) {
    const changes = new Map(), endOf = new Map();
    let unplaced = 0, noDuration = 0;
    topoOrder().forEach(id => {
      const t = tasks.get(id), d = parseDuration(t.duration);
      let s = parseTime(t.start), e = parseTime(t.end);
      if (s == null && e != null && d != null) s = e - d + INCL();
      if (t.locked) { if (s != null || e != null) endOf.set(id, e ?? s); else unplaced++; return; }   // never changed
      if (s == null && e == null) {
        const ends = edges.filter(x => x.to === id).map(x => endOf.get(x.from));
        if (ends.some(v => v == null)) s = null;           // something before it couldn't be placed
        else if (ends.length) s = Math.max(...ends) + NEXT();
        else s = from;
      }
      if (s != null && e == null && d != null) e = s + d - INCL();
      const c = {};
      if (s != null && !t.start) c.start = formatTime(s);
      if (e != null && !t.end) c.end = formatTime(e);
      if (c.start || c.end) {
        changes.set(id, c);
        if (e == null) noDuration++;                        // only a start: no duration to end it
      }
      if (s == null && e == null) unplaced++;
      else endOf.set(id, e ?? s);
    });
    return { changes, unplaced, noDuration };
  }

  function today() {
    const d = new Date();
    const day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
    return hourMode ? day * MIN_PER_DAY + 9 * 60 : day;     // 09:00 in hours
  }

  async function autoSchedule() {
    if (!tasks.size) { showStatus('Add some tasks first'); return; }
    let plan = planSchedule(null);
    if (plan.unplaced) {
      // Some tasks depend on nothing dated: ask where the plan starts.
      const known = [...tasks.values()].map(t => parseTime(t.start)).filter(v => v != null);
      const answer = await askDate({
        title: 'Auto-schedule', confirm: 'Schedule',
        value: formatTime(known.length ? Math.min(...known) : today()),
        text: 'Tasks without times are placed as early as their dependencies allow, starting from this ' +
              (hourMode ? 'time' : 'date') + '. Times you have set are kept.',
      });
      if (answer == null) return;
      plan = planSchedule(parseTime(answer));
    }
    if (!plan.changes.size) { showStatus('Nothing to schedule: every task already has its times'); return; }
    plan.changes.forEach((c, id) => {
      const t = tasks.get(id);
      Object.assign(t, c);
      t.duration = derivedDuration(t.start, t.end) ?? t.duration;
      renderTask(t);
    });
    changed();
    const n = plan.changes.size;
    showStatus(`Scheduled ${n} task${n === 1 ? '' : 's'}` +
      (plan.noDuration ? ` (${plan.noDuration} without a duration got only a start)` : '') + '. Undo takes it back.');
  }
  $('#auto-schedule').on('click', autoSchedule);

  // Apply an edit to start / end / duration, filling in the third value when possible.
  function setTiming(t, key, value) {
    t[key] = value === '' ? null : value;
    const s = parseTime(t.start), e = parseTime(t.end), d = parseDuration(t.duration), k = INCL();
    if (key === 'start' && s != null && e == null && d != null) t.end = formatTime(s + d - k);
    if (key === 'end' && e != null && s == null && d != null) t.start = formatTime(e - d + k);
    if (key === 'duration' && d != null) {
      if (s != null) t.end = formatTime(s + d - k);
      else if (e != null) t.start = formatTime(e - d + k);
    }
    t.duration = derivedDuration(t.start, t.end) ?? t.duration;
    renderTask(t);
    changed();
  }

  // Remove a start, end or duration. Clearing a date also drops a duration that
  // was only there because both dates were set, so no suggestion pops straight back.
  function clearTiming(key) {
    const t = tasks.get(selectedId);
    if (!t) return;
    if ((key === 'start' || key === 'end') && t.start && t.end) t.duration = null;
    t[key] = null;
    renderTask(t);
    changed();
  }
  $props.on('click', '.clear', function (e) {
    e.preventDefault();   // don't let the label move focus to its field
    clearTiming($(this).attr('data-key'));
  });

  async function deleteTask(id) {
    const t = tasks.get(id);
    if (!await confirmAction({
      title: `Delete “${t.name}”?`, confirm: 'Delete', danger: true,
      text: (hasEdges(id) ? 'Its dependencies are removed too. ' : '') + 'Undo brings it back.',
    })) return;
    if (!tasks.has(id)) return;
    closeProps();
    if (pending) cancelPending();
    edges.filter(e => e.from === id || e.to === id).forEach(e => e.el.remove());
    edges = edges.filter(e => e.from !== id && e.to !== id);
    t.$el.remove();
    tasks.delete(id);
    if (!tasks.size) $empty.show();
    changed();
    showStatus(`Deleted “${t.name}”`);
  }

  $world.on('click', '.task', function (e) {
    if (suppressClick || $(e.target).closest('.conn').length) return;
    openProps($(this).attr('data-id'));
  });

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
  $('#p-start').on('change', function () { setTiming(tasks.get(selectedId), 'start', this.value); });
  $('#p-end').on('change', function () { setTiming(tasks.get(selectedId), 'end', this.value); });
  $('#p-duration').on('change', function () {
    const t = tasks.get(selectedId);
    if (this.value.trim() === '') { setTiming(t, 'duration', ''); return; }
    if (hourMode) {
      const n = parseMinutes(this.value);
      if (n == null) { showStatus('Write a duration like 2h 30m, 45m, 1d 4h or 1.5', { error: true }); fillProps(); return; }
      setTiming(t, 'duration', durationValue(n));
    } else {
      const n = Math.round(+this.value);
      setTiming(t, 'duration', n >= 1 ? durationValue(n) : '');
    }
  });
  $props.on('keydown', 'input', e => {
    if (e.key === 'Enter') { $(e.target).trigger('change'); closeProps(); }
  });
  $('#props-close').on('click', closeProps);
  $('#p-accept').on('click', acceptSuggestion);
  $('#p-delete').on('click', () => deleteTask(selectedId));
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
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      // Second finger: switch to pinch-zoom; abandon any pan or box move.
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

    if ($(e.target).closest('.conn, .edge').length) return;   // handled by their click handlers
    const $task = $(e.target).closest('.task');
    if ($task.length) {
      const t = tasks.get($task.attr('data-id'));
      if (t.pinned) return;
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
      const others = [...tasks.values()].filter(o => o !== t).map(o => rectAt(o, o));
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

    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        // Carry on panning with the remaining finger; it doesn't count as a tap.
        const rest = [...pointers.values()][0];
        drag = rest ? { x: rest.x, y: rest.y, vx: view.x, vy: view.y, moved: true } : null;
      }
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

    if (drag && !drag.moved && e.type === 'pointerup') { cancelPending(); closeProps(); }   // tap on the background
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
    if (!tasks.size) { showStatus('Add some tasks first'); return; }
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
      title: `Open the shared graph (${(data.tasks || []).length} tasks)?`, confirm: 'Open',
      text: `It replaces the graph you have here (${tasks.size} tasks). Save that one first if you want to keep it.`,
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
