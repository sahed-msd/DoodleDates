/* ==========================================================================
   2026 DIGITAL CANVAS & TEXT DIARY CALENDAR
   Vanilla JS, no dependencies. Organized into clearly separated modules:

     1. CONFIG & UTILITIES
     2. STORAGE  — a tiny promise-based IndexedDB wrapper (not localStorage,
                    because 12 months of vector ink data can comfortably
                    exceed the 5MB localStorage ceiling)
     3. CALENDAR MATH — pure date helpers for 2026
     4. HOME VIEW — 12-month dashboard
     5. WORKSPACE — open/close transition between home and a single month
     6. DRAWING LAYER — HTML5 Canvas, pointer events, vector stroke storage
     7. TEXT NOTE LAYER — DOM sticky notes, draggable & editable
     8. TOOLBAR — mode / color / thickness controls
     9. HISTORY — per-month undo / redo (snapshot-based)
     10. AUTO-SAVE — debounced + event-driven persistence
     11. EXPORT / IMPORT — whole-year JSON backup & restore
     12. STORAGE HEALTH — persistent-storage request + quota warning
     13. INIT
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. CONFIG & UTILITIES
   * ------------------------------------------------------------------ */
  const YEAR = 2026;
  const MONTH_NAMES = ["January","February","March","April","May","June",
                        "July","August","September","October","November","December"];
  const DOW_LABELS = ["SUN","MON","TUE","WED","THU","FRI","SAT"];

  const INK_COLORS = [
    { name: "Ink Navy",  value: "#232323" },
    { name: "Brass",     value: "#C9A227" },
    { name: "Teal",      value: "#2F6F62" },
    { name: "Rose",      value: "#8B3A3A" },
    { name: "Blue",      value: "#2C4A73" },
  ];

  /** Debounce: delays fn until `wait` ms of silence. Also exposes .flush()
   *  to force immediate execution — needed for beforeunload. */
  function debounce(fn, wait) {
    let timer = null;
    let pendingArgs = null;
    const wrapped = (...args) => {
      pendingArgs = args;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(...pendingArgs); }, wait);
    };
    wrapped.flush = () => {
      if (timer) { clearTimeout(timer); timer = null; fn(...(pendingArgs || [])); }
    };
    return wrapped;
  }

  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const monthKey = (m) => `${YEAR}-${String(m + 1).padStart(2, "0")}`;
  const isToday = (m, d) => {
    const t = new Date();
    return t.getFullYear() === YEAR && t.getMonth() === m && t.getDate() === d;
  };

  /* ----------------------------------------------------------------------
   * BANGLADESH 2026 GOVERNMENT HOLIDAYS
   * Official General/Executive-Order holiday list (month index is 0-based).
   * Islamic dates (Shab-e-Barat, Laylat al-Qadr, Eid-ul-Fitr, Eid-ul-Azha,
   * Ashura, Eid-e-Milad-un-Nabi) follow the lunar Hijri calendar and are
   * subject to moon sighting — the government may shift these by ±1 day
   * closer to the date; that's noted on the highlighted cell itself.
   * -------------------------------------------------------------------- */
  const BD_HOLIDAYS_2026 = [
    { m: 1,  d: 4,  name: "Shab-e-Barat", moon: true },
    { m: 1,  d: 21, name: "Shaheed Day / Int'l Mother Language Day" },
    { m: 2,  d: 17, name: "Sheikh Mujibur Rahman's Birthday" },
    { m: 2,  d: 18, name: "Laylat al-Qadr", moon: true },
    { m: 2,  d: 19, name: "Eid-ul-Fitr Holiday", moon: true },
    { m: 2,  d: 20, name: "Jumatul Wida / Eid Holiday", moon: true },
    { m: 2,  d: 21, name: "Eid-ul-Fitr", moon: true },
    { m: 2,  d: 22, name: "Eid-ul-Fitr Holiday", moon: true },
    { m: 2,  d: 23, name: "Eid-ul-Fitr Holiday", moon: true },
    { m: 2,  d: 26, name: "Independence Day" },
    { m: 3,  d: 14, name: "Pohela Boishakh (Bengali New Year)" },
    { m: 4,  d: 1,  name: "May Day / Buddha Purnima" },
    { m: 4,  d: 26, name: "Eid-ul-Azha Holiday", moon: true },
    { m: 4,  d: 27, name: "Eid-ul-Azha", moon: true },
    { m: 4,  d: 28, name: "Eid-ul-Azha Holiday", moon: true },
    { m: 4,  d: 29, name: "Eid-ul-Azha Holiday", moon: true },
    { m: 4,  d: 30, name: "Eid-ul-Azha Holiday", moon: true },
    { m: 4,  d: 31, name: "Eid-ul-Azha Holiday", moon: true },
    { m: 5,  d: 26, name: "Ashura", moon: true },
    { m: 7,  d: 5,  name: "July Mass Uprising Day" },
    { m: 7,  d: 15, name: "National Mourning Day" },
    { m: 7,  d: 26, name: "Eid-e-Milad-un-Nabi", moon: true },
    { m: 9,  d: 20, name: "Durga Puja (Maha Navami)" },
    { m: 9,  d: 21, name: "Vijaya Dashami" },
    { m: 11, d: 16, name: "Victory Day" },
    { m: 11, d: 25, name: "Christmas Day" },
  ];
  // Fast lookup: "m-d" -> holiday record
  const HOLIDAY_MAP = new Map(BD_HOLIDAYS_2026.map(h => [`${h.m}-${h.d}`, h]));
  const getHoliday = (m, d) => HOLIDAY_MAP.get(`${m}-${d}`) || null;

  /** Weekly off ("Bandh") days — Bangladesh's government weekend is
   *  Friday & Saturday (not Sat/Sun). */
  const isWeeklyBandh = (m, d) => {
    const dow = new Date(YEAR, m, d).getDay();
    return dow === 5 || dow === 6; // Fri = 5, Sat = 6
  };

  /* ------------------------------------------------------------------ *
   * 2. STORAGE — lightweight IndexedDB wrapper
   * ------------------------------------------------------------------ */
  const DB_NAME = "diaryCalendar2026";
  const DB_VERSION = 1;
  const STORE = "months";
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbGet(key) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result ? req.result.data : null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn("IndexedDB read failed, falling back to localStorage", e);
      const raw = localStorage.getItem(`diary:${key}`);
      return raw ? JSON.parse(raw) : null;
    }
  }

  async function idbSet(key, data) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ key, data });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn("IndexedDB write failed, falling back to localStorage", e);
      try { localStorage.setItem(`diary:${key}`, JSON.stringify(data)); } catch (_) { /* full, give up silently */ }
    }
  }

  async function idbGetAllKeys() {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return Object.keys(localStorage).filter(k => k.startsWith("diary:")).map(k => k.slice(6));
    }
  }

  /** Synchronous best-effort save used only on beforeunload, where async
   *  IndexedDB completion isn't guaranteed. Mirrors the state to
   *  localStorage instantly as a safety net; the IndexedDB write is also
   *  fired (it will usually complete in time on modern browsers). */
  function saveSync(key, data) {
    try { localStorage.setItem(`diary:${key}`, JSON.stringify(data)); } catch (_) {}
    idbSet(key, data);
  }

  /* ------------------------------------------------------------------ *
   * 3. CALENDAR MATH
   * ------------------------------------------------------------------ */
  function getMonthMatrix(m) {
    // Returns an array of weeks; each week is an array of 7 cells:
    // { day: number|null }. Always starts week on Sunday.
    const firstDow = new Date(YEAR, m, 1).getDay();
    const daysInMonth = new Date(YEAR, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  /* ------------------------------------------------------------------ *
   * 4. HOME VIEW
   * ------------------------------------------------------------------ */
  const homeGrid = document.getElementById("homeView");

  function buildMonthCard(m) {
    const card = document.createElement("article");
    card.className = "month-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Open ${MONTH_NAMES[m]} ${YEAR}`);
    card.dataset.month = String(m);

    const binder = document.createElement("div");
    binder.className = "binder";
    binder.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 6; i++) binder.appendChild(document.createElement("span")).className = "ring";
    card.appendChild(binder);

    const dot = document.createElement("span");
    dot.className = "has-content-dot";
    dot.dataset.dotFor = monthKey(m);
    card.appendChild(dot);

    const name = document.createElement("h3");
    name.className = "month-card-name";
    name.textContent = MONTH_NAMES[m];
    card.appendChild(name);

    const yr = document.createElement("p");
    yr.className = "month-card-year";
    yr.textContent = String(YEAR);
    card.appendChild(yr);

    const mini = document.createElement("div");
    mini.className = "mini-grid";
    DOW_LABELS.forEach(l => {
      const el = document.createElement("div");
      el.className = "mini-dow";
      el.textContent = l[0];
      mini.appendChild(el);
    });
    getMonthMatrix(m).forEach(week => {
      week.forEach(day => {
        const cell = document.createElement("div");
        if (day === null) {
          cell.className = "mini-day blank";
        } else {
          const holiday = getHoliday(m, day);
          const classes = ["mini-day"];
          if (holiday) classes.push("holiday");
          else if (isWeeklyBandh(m, day)) classes.push("weekly-bandh");
          if (isToday(m, day)) classes.push("today");
          cell.className = classes.join(" ");
          cell.textContent = day;
          if (holiday) cell.title = holiday.name + (holiday.moon ? " (date may shift by moon sighting)" : "");
          else if (isWeeklyBandh(m, day)) cell.title = "Weekly off (Bandh)";
        }
        mini.appendChild(cell);
      });
    });
    card.appendChild(mini);

    card.addEventListener("click", () => openWorkspace(m));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWorkspace(m); }
    });

    return card;
  }

  function renderHome() {
    homeGrid.innerHTML = "";
    for (let m = 0; m < 12; m++) homeGrid.appendChild(buildMonthCard(m));
  }

  /** Lights up the ink-dot on any month card that already has saved content. */
  async function refreshContentDots() {
    const keys = await idbGetAllKeys();
    const keySet = new Set(keys);
    document.querySelectorAll(".has-content-dot").forEach(dot => {
      dot.classList.toggle("visible", keySet.has(dot.dataset.dotFor));
    });
  }

  /* ------------------------------------------------------------------ *
   * 5. WORKSPACE — open / close transition
   * ------------------------------------------------------------------ */
  const workspaceView   = document.getElementById("workspaceView");
  const workspaceTitle  = document.getElementById("workspaceTitle");
  const calendarGridEl  = document.getElementById("calendarGrid");
  const canvasWrap      = document.getElementById("canvasWrap");
  const drawCanvas      = document.getElementById("drawCanvas");
  const notesLayer      = document.getElementById("notesLayer");
  const backBtn         = document.getElementById("backBtn");

  let currentMonth = null;               // index 0-11, or null when at home
  let monthState = { strokes: [], notes: [] }; // in-memory state for the open month
  let resizeObserver = null;

  function renderCalendarGridBase(m) {
    calendarGridEl.innerHTML = "";

    const dowRow = document.createElement("div");
    dowRow.className = "cg-dow-row";
    DOW_LABELS.forEach(l => {
      const el = document.createElement("div");
      el.className = "cg-dow";
      el.textContent = l;
      dowRow.appendChild(el);
    });
    calendarGridEl.appendChild(dowRow);

    const weeksWrap = document.createElement("div");
    weeksWrap.className = "cg-weeks";
    const matrix = getMonthMatrix(m);
    weeksWrap.style.gridTemplateRows = `repeat(${matrix.length}, 1fr)`;

    matrix.forEach(week => {
      const weekEl = document.createElement("div");
      weekEl.className = "cg-week";
      week.forEach(day => {
        const cell = document.createElement("div");
        const cellClasses = ["cg-cell"];
        if (day === null) {
          cellClasses.push("blank");
        } else {
          const holiday = getHoliday(m, day);
          if (holiday) {
            cellClasses.push("holiday");
            cell.title = holiday.name + (holiday.moon ? " (date may shift by moon sighting)" : "");
          } else if (isWeeklyBandh(m, day)) {
            cellClasses.push("weekly-bandh");
            cell.title = "Weekly off (Bandh)";
          }
        }
        cell.className = cellClasses.join(" ");
        if (day !== null) {
          const num = document.createElement("span");
          num.className = "cg-daynum" + (isToday(m, day) ? " today" : "");
          num.textContent = day;
          cell.appendChild(num);

          const holiday = getHoliday(m, day);
          if (holiday) {
            const label = document.createElement("span");
            label.className = "cg-holiday-label";
            label.textContent = holiday.name;
            cell.appendChild(label);
          } else if (isWeeklyBandh(m, day)) {
            const label = document.createElement("span");
            label.className = "cg-holiday-label cg-bandh-label";
            label.textContent = "Bandh";
            cell.appendChild(label);
          }
        }
        weekEl.appendChild(cell);
      });
      weeksWrap.appendChild(weekEl);
    });
    calendarGridEl.appendChild(weeksWrap);
  }

  async function openWorkspace(m) {
    currentMonth = m;
    workspaceTitle.textContent = `${MONTH_NAMES[m]} ${YEAR}`;
    renderCalendarGridBase(m);

    // Load saved diary state for this month (or start fresh)
    const saved = await idbGet(monthKey(m));
    monthState = saved && typeof saved === "object"
      ? { strokes: saved.strokes || [], notes: saved.notes || [] }
      : { strokes: [], notes: [] };
    resetHistory(); // undo/redo history is per-month and in-memory only
    checkStorageHealth();

    workspaceView.classList.add("open");
    workspaceView.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    // Canvas must be sized *after* the workspace is visible/laid out
    requestAnimationFrame(() => {
      resizeCanvasToWrap();
      redrawCanvas();
      rebuildNotesDOM();
      observeResize();
    });
  }

  async function closeWorkspace() {
    if (currentMonth === null) return;
    await persistNow();          // make sure the page is saved before leaving
    workspaceView.classList.remove("open");
    workspaceView.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    notesLayer.innerHTML = "";
    const closedMonthKey = monthKey(currentMonth);
    currentMonth = null;
    refreshContentDots();
  }

  backBtn.addEventListener("click", closeWorkspace);
  // Escape key also returns to overview, mirroring the "Back" affordance
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && currentMonth !== null) closeWorkspace();
  });

  function observeResize() {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => {
      resizeCanvasToWrap();
      redrawCanvas();
      // Notes are positioned with % coordinates in CSS, so they reflow
      // automatically — no JS repositioning needed on resize.
    });
    resizeObserver.observe(canvasWrap);
  }

  /* ------------------------------------------------------------------ *
   * 6. DRAWING LAYER (HTML5 Canvas)
   *    Strokes are stored in RELATIVE coordinates (0..1 fractions of the
   *    canvas's current width/height) so the vector art can be replayed
   *    at any viewport size without clipping, distortion, or misalignment
   *    with the calendar grid beneath it.
   * ------------------------------------------------------------------ */
  const ctx = drawCanvas.getContext("2d");
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  let currentMode = "pen";     // 'pen' | 'text' | 'erase'
  let currentColor = INK_COLORS[0].value;
  let currentWidth = 3;        // in CSS px at the canvas's *current* size

  let activeStroke = null;     // stroke currently being drawn
  let drawingPointerId = null;

  function resizeCanvasToWrap() {
    const rect = canvasWrap.getBoundingClientRect();
    dpr = Math.max(1, window.devicePixelRatio || 1);
    drawCanvas.width = Math.round(rect.width * dpr);
    drawCanvas.height = Math.round(rect.height * dpr);
    drawCanvas.style.width = rect.width + "px";
    drawCanvas.style.height = rect.height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel space
  }

  function relPointFromEvent(e) {
    const rect = drawCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
      p: e.pressure && e.pressure > 0 ? e.pressure : 0.5, // pressure-sensitive when available
    };
  }

  function strokeToAbsPoints(stroke, cssW, cssH) {
    return stroke.points.map(pt => ({ x: pt.x * cssW, y: pt.y * cssH, p: pt.p }));
  }

  function drawStroke(stroke, cssW, cssH) {
    const pts = strokeToAbsPoints(stroke, cssW, cssH);
    if (pts.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = stroke.type === "erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (pts.length === 1) {
      // A single tap/dot: draw a filled circle so clicks are visible
      const r = (stroke.width * (pts[0].p || 0.5) * 2) / 2;
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, Math.max(r, 0.75), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    // Pressure-responsive width: vary line width along the path using
    // short connected segments so thickness feels alive under a stylus.
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const pressure = (a.p + b.p) / 2;
      ctx.lineWidth = Math.max(stroke.width * (0.55 + pressure * 0.9), 0.6);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Full redraw — replays every stored stroke in order. Called after
   *  loading a month and after every resize, so vector ink always lines
   *  up exactly with the calendar dates beneath it. */
  function redrawCanvas() {
    const rect = canvasWrap.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    for (const stroke of monthState.strokes) drawStroke(stroke, rect.width, rect.height);
  }

  function pointerDownOnCanvas(e) {
    if (currentMode === "text") return; // canvas ignores clicks in text mode (see CSS pointer-events)
    if (drawingPointerId !== null) return;
    drawingPointerId = e.pointerId;
    drawCanvas.setPointerCapture(e.pointerId);

    pushHistorySnapshot(); // record state as it was *before* this stroke

    activeStroke = {
      id: uid(),
      type: currentMode === "erase" ? "erase" : "pen",
      color: currentColor,
      width: currentWidth,
      points: [relPointFromEvent(e)],
    };
    monthState.strokes.push(activeStroke);

    const rect = canvasWrap.getBoundingClientRect();
    drawStroke(activeStroke, rect.width, rect.height);
    e.preventDefault();
  }

  /** Draws only the newest segment of the *currently active* stroke,
   *  without clearing the canvas first. This is what pointermove uses —
   *  drawing on top of the existing pixels is correct for both ink
   *  (source-over) and the eraser (destination-out erases whatever is
   *  already on the canvas right now), and is dramatically cheaper than
   *  replaying every stroke on every mouse-move for a page with a lot of
   *  ink on it. Full replay via redrawCanvas() is reserved for cases where
   *  the canvas content actually needs to be rebuilt from scratch: initial
   *  load, resize, undo/redo, and Clear. */
  function drawActiveSegmentIncremental(stroke, cssW, cssH) {
    const pts = stroke.points;
    if (pts.length < 2) return;
    const p1 = pts[pts.length - 2], p2 = pts[pts.length - 1];
    const pressure = (p1.p + p2.p) / 2;
    ctx.save();
    ctx.globalCompositeOperation = stroke.type === "erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(stroke.width * (0.55 + pressure * 0.9), 0.6);
    ctx.beginPath();
    ctx.moveTo(p1.x * cssW, p1.y * cssH);
    ctx.lineTo(p2.x * cssW, p2.y * cssH);
    ctx.stroke();
    ctx.restore();
  }

  function pointerMoveOnCanvas(e) {
    if (activeStroke === null || e.pointerId !== drawingPointerId) return;
    activeStroke.points.push(relPointFromEvent(e));
    const rect = canvasWrap.getBoundingClientRect();
    drawActiveSegmentIncremental(activeStroke, rect.width, rect.height);
    e.preventDefault();
  }

  function pointerUpOnCanvas(e) {
    if (e.pointerId !== drawingPointerId) return;
    drawingPointerId = null;
    if (drawCanvas.hasPointerCapture(e.pointerId)) drawCanvas.releasePointerCapture(e.pointerId);
    activeStroke = null;
    scheduleSave();
  }

  drawCanvas.addEventListener("pointerdown", pointerDownOnCanvas);
  drawCanvas.addEventListener("pointermove", pointerMoveOnCanvas);
  drawCanvas.addEventListener("pointerup", pointerUpOnCanvas);
  drawCanvas.addEventListener("pointercancel", pointerUpOnCanvas);
  drawCanvas.addEventListener("pointerleave", (e) => { if (e.pointerId === drawingPointerId) pointerUpOnCanvas(e); });

  /* ------------------------------------------------------------------ *
   * 7. TEXT NOTE LAYER (DOM sticky notes)
   *    Notes are positioned with left/top in PERCENT of the wrap, so they
   *    stay pixel-perfectly aligned with the calendar/canvas beneath them
   *    on any viewport size without any JS repositioning on resize.
   *
   *    Each note now supports:
   *      - Resizing (drag the corner handle) — stored as widthPx/heightPx
   *      - Rich formatting — bold / italic / underline / highlight /
   *        text color, applied via a small floating toolbar that appears
   *        while the note is focused
   *      - A paper color for the note itself, independent of ink color
   *      - Adjustable font size
   *    Formatted content is stored as sanitized HTML (note.html) rather
   *    than plain text so formatting survives save/reload.
   * ------------------------------------------------------------------ */

  const NOTE_HIGHLIGHTS = ["#FFF3A0", "#B7E3D8", "#F6C6C6", "none"];
  const NOTE_PAPERS = [
    { name: "Cream",  value: "rgba(255, 250, 230, 0.92)" },
    { name: "Blush",  value: "rgba(248, 226, 221, 0.92)" },
    { name: "Mint",   value: "rgba(220, 238, 227, 0.92)" },
    { name: "Sky",    value: "rgba(220, 232, 245, 0.92)" },
    { name: "Sand",   value: "rgba(238, 230, 210, 0.92)" },
  ];
  const FONT_SIZE_MIN = 11, FONT_SIZE_MAX = 22, FONT_SIZE_DEFAULT = 13.5;
  let noteZCounter = 1; // transient stacking order, not persisted

  /** Whitelist-based HTML sanitizer for note content. Runs on every note
   *  before it's written into the DOM via innerHTML — including notes
   *  loaded from a *.json backup import, which is untrusted input. Only a
   *  small set of formatting tags/styles survive; everything else
   *  (scripts, event handler attributes, foreign tags) is stripped or
   *  unwrapped rather than dropped, so legitimate text is never lost. */
  function sanitizeNoteHtml(html) {
    const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "SPAN", "BR", "DIV"]);
    const ALLOWED_STYLES = new Set(["color", "background-color", "font-weight", "font-style", "text-decoration"]);
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html || "");

    const clean = (parent) => {
      Array.from(parent.childNodes).forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (!ALLOWED_TAGS.has(node.tagName)) {
            // Unwrap disallowed elements instead of deleting their text
            while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
            node.parentNode.removeChild(node);
            return;
          }
          const style = node.getAttribute("style");
          Array.from(node.attributes).forEach(attr => node.removeAttribute(attr.name));
          if (style) {
            const kept = style.split(";")
              .map(s => s.trim()).filter(Boolean)
              .filter(rule => ALLOWED_STYLES.has(rule.split(":")[0].trim().toLowerCase()));
            if (kept.length) node.setAttribute("style", kept.join("; "));
          }
          clean(node);
        } else if (node.nodeType !== Node.TEXT_NODE) {
          node.remove(); // strip comments and anything else
        }
      });
    };
    clean(tpl.content);
    return tpl.innerHTML;
  }

  function createNoteElement(note) {
    // Backfill defaults for notes saved before these fields existed
    note.html = note.html != null ? note.html : escapeHtml(note.text || "");
    note.bg = note.bg || NOTE_PAPERS[0].value;
    note.fontSize = note.fontSize || FONT_SIZE_DEFAULT;
    note.heightPx = note.heightPx || null; // null = auto-grow with content

    const el = document.createElement("div");
    el.className = "sticky-note";
    el.style.left = `${note.xPct}%`;
    el.style.top = `${note.yPct}%`;
    el.style.width = `${note.widthPx || 180}px`;
    if (note.heightPx) el.style.height = `${note.heightPx}px`;
    el.style.background = note.bg;
    el.dataset.id = note.id;

    const bringToFront = () => { el.style.zIndex = String(++noteZCounter); };

    const del = document.createElement("button");
    del.className = "note-del";
    del.type = "button";
    del.title = "Delete note";
    del.textContent = "×";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      pushHistorySnapshot();
      monthState.notes = monthState.notes.filter(n => n.id !== note.id);
      el.remove();
      scheduleSave();
    });
    el.appendChild(del);

    /* ---- Floating formatting toolbar (shown while the note is active) --- */
    const toolbar = document.createElement("div");
    toolbar.className = "note-toolbar";

    const runCmd = (cmd, val) => {
      text.focus();
      try { document.execCommand(cmd, false, val); } catch (_) { /* unsupported in this browser, ignore */ }
      note.html = sanitizeNoteHtml(text.innerHTML);
      scheduleSave();
    };
    const mkToolBtn = (label, title, onClick, extraClass) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "note-tool-btn" + (extraClass ? ` ${extraClass}` : "");
      b.title = title;
      b.innerHTML = label;
      // mousedown (not click) + preventDefault keeps the text selection
      // alive — a normal click would blur the contentEditable first.
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
      return b;
    };

    toolbar.appendChild(mkToolBtn("<b>B</b>", "Bold", () => runCmd("bold")));
    toolbar.appendChild(mkToolBtn("<i>I</i>", "Italic", () => runCmd("italic")));
    toolbar.appendChild(mkToolBtn("<u>U</u>", "Underline", () => runCmd("underline")));

    const sep1 = document.createElement("span"); sep1.className = "note-tool-sep"; toolbar.appendChild(sep1);

    // Text (ink) color swatches — reuses the diary's ink palette
    INK_COLORS.forEach(c => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "note-swatch";
      b.style.background = c.value;
      b.title = `Text color: ${c.name}`;
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.addEventListener("click", (ev) => { ev.stopPropagation(); runCmd("foreColor", c.value); });
      toolbar.appendChild(b);
    });

    const sep2 = document.createElement("span"); sep2.className = "note-tool-sep"; toolbar.appendChild(sep2);

    // Highlight swatches (last one clears highlighting)
    NOTE_HIGHLIGHTS.forEach(hc => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "note-swatch note-swatch--highlight" + (hc === "none" ? " note-swatch--clear" : "");
      b.style.background = hc === "none" ? "transparent" : hc;
      b.title = hc === "none" ? "Clear highlight" : "Highlight text";
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        text.focus();
        try { document.execCommand("hiliteColor", false, hc === "none" ? "transparent" : hc); }
        catch (_) { try { document.execCommand("backColor", false, hc === "none" ? "transparent" : hc); } catch (__) {} }
        note.html = sanitizeNoteHtml(text.innerHTML);
        scheduleSave();
      });
      toolbar.appendChild(b);
    });

    const sep3 = document.createElement("span"); sep3.className = "note-tool-sep"; toolbar.appendChild(sep3);

    // Font size stepper
    const sizeDown = mkToolBtn("A−", "Smaller text", () => {
      note.fontSize = Math.max(FONT_SIZE_MIN, note.fontSize - 1.5);
      text.style.fontSize = `${note.fontSize}px`;
      scheduleSave();
    });
    const sizeUp = mkToolBtn("A+", "Larger text", () => {
      note.fontSize = Math.min(FONT_SIZE_MAX, note.fontSize + 1.5);
      text.style.fontSize = `${note.fontSize}px`;
      scheduleSave();
    });
    toolbar.appendChild(sizeDown);
    toolbar.appendChild(sizeUp);

    const sep4 = document.createElement("span"); sep4.className = "note-tool-sep"; toolbar.appendChild(sep4);

    // Note paper color swatches
    NOTE_PAPERS.forEach(p => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "note-swatch note-swatch--paper";
      b.style.background = p.value;
      b.title = `Note color: ${p.name}`;
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        note.bg = p.value;
        el.style.background = p.value;
        scheduleSave();
      });
      toolbar.appendChild(b);
    });

    el.appendChild(toolbar);

    /* ------------------------------- Editable text ------------------------------- */
    const text = document.createElement("div");
    text.className = "note-text";
    text.contentEditable = "true";
    text.style.fontSize = `${note.fontSize}px`;
    text.innerHTML = sanitizeNoteHtml(note.html);
    text.addEventListener("input", () => {
      note.html = sanitizeNoteHtml(text.innerHTML);
      scheduleSave();
    });
    text.addEventListener("focus", () => { el.classList.add("note-active"); bringToFront(); });
    text.addEventListener("blur", () => {
      // Delay so a click on the toolbar (which steals focus momentarily)
      // doesn't immediately hide itself before the command runs.
      setTimeout(() => { if (!el.contains(document.activeElement)) el.classList.remove("note-active"); }, 150);
    });
    // Prevent the drawing canvas (or note dragging) from stealing clicks
    // meant for text editing.
    text.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    el.appendChild(text);

    /* ------------------------------- Dragging ------------------------------- */
    // Pointerdown anywhere on the note *except* the editable text, toolbar,
    // delete button, or resize handle repositions it. Stored as percentages
    // so it stays aligned with the calendar beneath it on any viewport size.
    let dragging = false, startX = 0, startY = 0, startLeftPct = 0, startTopPct = 0;
    el.addEventListener("pointerdown", (ev) => {
      if (ev.target === text || ev.target === del || toolbar.contains(ev.target)) return;
      if (ev.target.classList && ev.target.classList.contains("note-resize-handle")) return;
      dragging = true;
      bringToFront();
      el.classList.add("dragging");
      el.setPointerCapture(ev.pointerId);
      const wrapRect = canvasWrap.getBoundingClientRect();
      startX = ev.clientX; startY = ev.clientY;
      startLeftPct = note.xPct; startTopPct = note.yPct;
      el._wrapRect = wrapRect;
    });
    el.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const wrapRect = el._wrapRect;
      const dxPct = ((ev.clientX - startX) / wrapRect.width) * 100;
      const dyPct = ((ev.clientY - startY) / wrapRect.height) * 100;
      note.xPct = Math.min(96, Math.max(0, startLeftPct + dxPct));
      note.yPct = Math.min(96, Math.max(0, startTopPct + dyPct));
      el.style.left = `${note.xPct}%`;
      el.style.top = `${note.yPct}%`;
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("dragging");
      scheduleSave();
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);

    /* ------------------------------- Resizing ------------------------------- */
    const handle = document.createElement("div");
    handle.className = "note-resize-handle";
    handle.title = "Drag to resize";
    let resizing = false, resizeStartX = 0, resizeStartY = 0, startW = 0, startH = 0;
    handle.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      resizing = true;
      bringToFront();
      handle.setPointerCapture(ev.pointerId);
      resizeStartX = ev.clientX; resizeStartY = ev.clientY;
      startW = el.offsetWidth; startH = el.offsetHeight;
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!resizing) return;
      const newW = Math.max(120, Math.min(680, startW + (ev.clientX - resizeStartX)));
      const newH = Math.max(50, Math.min(680, startH + (ev.clientY - resizeStartY)));
      note.widthPx = newW;
      note.heightPx = newH;
      el.style.width = `${newW}px`;
      el.style.height = `${newH}px`;
    });
    const endResize = (ev) => {
      if (!resizing) return;
      resizing = false;
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      scheduleSave();
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
    el.appendChild(handle);

    return el;
  }

  /** Escapes plain text for safe insertion as HTML — used only as a
   *  one-time upgrade path for notes saved before rich formatting existed
   *  (note.text without note.html). */
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function rebuildNotesDOM() {
    notesLayer.innerHTML = "";
    for (const note of monthState.notes) notesLayer.appendChild(createNoteElement(note));
  }

  notesLayer.addEventListener("click", (e) => {
    if (currentMode !== "text") return;
    if (e.target !== notesLayer) return; // ignore clicks on existing notes (handled by their own listeners)
    const rect = canvasWrap.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top) / rect.height) * 100;
    pushHistorySnapshot();
    const note = {
      id: uid(), xPct, yPct, widthPx: 180, heightPx: null,
      html: "", color: currentColor, bg: NOTE_PAPERS[0].value, fontSize: FONT_SIZE_DEFAULT,
    };
    monthState.notes.push(note);
    const el = createNoteElement(note);
    notesLayer.appendChild(el);
    requestAnimationFrame(() => el.querySelector(".note-text").focus());
    scheduleSave();
  });

  /* ------------------------------------------------------------------ *
   * 8. TOOLBAR — mode / color / thickness controls
   * ------------------------------------------------------------------ */
  const modeGroup       = document.getElementById("modeGroup");
  const paletteGroup     = document.getElementById("paletteGroup");
  const thicknessSlider  = document.getElementById("thicknessSlider");
  const clearBtn         = document.getElementById("clearBtn");

  function setMode(mode) {
    currentMode = mode;
    modeGroup.querySelectorAll(".mode-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    drawCanvas.classList.toggle("mode-text", mode === "text");
    notesLayer.classList.toggle("mode-text", mode === "text");
    drawCanvas.style.cursor = mode === "erase" ? "cell" : "crosshair";
  }
  modeGroup.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn");
    if (btn) setMode(btn.dataset.mode);
  });

  function buildPalette() {
    paletteGroup.innerHTML = "";
    INK_COLORS.forEach((c, i) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "swatch" + (i === 0 ? " active" : "");
      sw.style.background = c.value;
      sw.title = c.name;
      sw.addEventListener("click", () => {
        currentColor = c.value;
        paletteGroup.querySelectorAll(".swatch").forEach(s => s.classList.remove("active"));
        sw.classList.add("active");
      });
      paletteGroup.appendChild(sw);
    });
  }
  buildPalette();

  thicknessSlider.addEventListener("input", () => {
    currentWidth = Number(thicknessSlider.value);
  });

  clearBtn.addEventListener("click", () => {
    if (currentMonth === null) return;
    if (!confirm(`Clear all ink and notes from ${MONTH_NAMES[currentMonth]}? You can still undo this with the Undo button.`)) return;
    pushHistorySnapshot();
    monthState = { strokes: [], notes: [] };
    redrawCanvas();
    rebuildNotesDOM();
    scheduleSave();
  });

  /* ------------------------------------------------------------------ *
   * 9. HISTORY — per-month undo / redo
   *    Snapshot-based: before each meaningful mutation (a completed stroke,
   *    a note being added/deleted, or a full Clear) we push a deep clone of
   *    monthState onto a history stack. Undo pops that snapshot back in;
   *    Redo replays it forward. Continuous edits (typing inside a note,
   *    dragging a note) are intentionally NOT snapshotted individually —
   *    only the discrete action that started them — so undo stays coarse
   *    and predictable rather than firing on every keystroke.
   *    History is kept in memory only and resets whenever a different
   *    month is opened; it is not persisted.
   * ------------------------------------------------------------------ */
  const MAX_HISTORY = 50;
  let historyStack = [];
  let redoStack = [];

  const cloneState = (state) => JSON.parse(JSON.stringify(state));

  function pushHistorySnapshot() {
    if (currentMonth === null) return;
    historyStack.push(cloneState(monthState));
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    redoStack = []; // a fresh action invalidates any previously undone redo path
    updateHistoryButtons();
  }

  function resetHistory() {
    historyStack = [];
    redoStack = [];
    updateHistoryButtons();
  }

  function undo() {
    if (historyStack.length === 0) return;
    redoStack.push(cloneState(monthState));
    monthState = historyStack.pop();
    redrawCanvas();
    rebuildNotesDOM();
    scheduleSave();
    updateHistoryButtons();
  }

  function redo() {
    if (redoStack.length === 0) return;
    historyStack.push(cloneState(monthState));
    monthState = redoStack.pop();
    redrawCanvas();
    rebuildNotesDOM();
    scheduleSave();
    updateHistoryButtons();
  }

  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");

  function updateHistoryButtons() {
    undoBtn.disabled = historyStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);

  // Keyboard shortcuts: Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) to redo.
  // Ignored while a note is actively being edited so it doesn't fight the
  // browser's native text-field undo.
  document.addEventListener("keydown", (e) => {
    if (currentMonth === null) return;
    const editingText = document.activeElement && document.activeElement.classList.contains("note-text");
    if (editingText) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  });

  /* ------------------------------------------------------------------ *
   * 10. AUTO-SAVE — zero manual save buttons
   *    - Debounced background save fires ~700ms after the last edit.
   *    - Immediate (flushed) save on: leaving to the overview, tab hidden,
   *      and window/tab close (beforeunload).
   * ------------------------------------------------------------------ */
  const saveIndicator = document.getElementById("saveIndicator");

  async function persistNow() {
    if (currentMonth === null) return;
    await idbSet(monthKey(currentMonth), monthState);
    flashSaved();
  }

  function flashSaved() {
    saveIndicator.textContent = "Saved";
    saveIndicator.classList.add("pulsing");
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => saveIndicator.classList.remove("pulsing"), 900);
  }

  const saveScheduler = debounce(async () => {
    if (currentMonth === null) return;
    await idbSet(monthKey(currentMonth), monthState);
    flashSaved();
  }, 700);

  function scheduleSave() {
    saveIndicator.textContent = "Saving…";
    saveScheduler();
  }

  // Flush any pending save immediately when the tab is closed or hidden —
  // covers refresh, navigation away, and mobile backgrounding.
  window.addEventListener("beforeunload", () => {
    if (currentMonth === null) return;
    saveScheduler.flush();
    saveSync(monthKey(currentMonth), monthState); // synchronous safety net
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && currentMonth !== null) {
      saveScheduler.flush();
    }
  });

  /* ------------------------------------------------------------------ *
   * 11. EXPORT / IMPORT — whole-year JSON backup & restore
   *    IndexedDB lives only in this browser profile: clearing site data,
   *    switching browsers/devices, or a corrupted profile means total
   *    loss with no recovery path. Export serializes every saved month
   *    into one downloadable .json file; Import restores from that file.
   * ------------------------------------------------------------------ */
  const exportBtn  = document.getElementById("exportBtn");
  const importBtn  = document.getElementById("importBtn");
  const importFile = document.getElementById("importFile");

  async function exportYearToFile() {
    const keys = await idbGetAllKeys();
    const months = {};
    for (const key of keys) {
      const data = await idbGet(key);
      if (data) months[key] = data;
    }
    const payload = { app: "diary-calendar", year: YEAR, exportedAt: new Date().toISOString(), months };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diary-calendar-${YEAR}-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importYearFromFile(file) {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch (e) {
      alert("That file doesn't look like a valid diary backup (couldn't parse JSON).");
      return;
    }
    if (!payload || typeof payload.months !== "object") {
      alert("That file doesn't look like a valid diary backup (missing month data).");
      return;
    }
    const incomingKeys = Object.keys(payload.months);
    if (incomingKeys.length === 0) {
      alert("That backup file doesn't contain any month entries.");
      return;
    }
    const proceed = confirm(
      `This will overwrite ${incomingKeys.length} month(s) of existing entries with data from the backup file. Continue?`
    );
    if (!proceed) return;

    for (const key of incomingKeys) {
      await idbSet(key, payload.months[key]);
    }

    // If the month currently open was just overwritten, reload it live.
    if (currentMonth !== null && incomingKeys.includes(monthKey(currentMonth))) {
      await openWorkspace(currentMonth);
    }
    refreshContentDots();
    checkStorageHealth();
    alert("Backup imported successfully.");
  }

  exportBtn.addEventListener("click", exportYearToFile);
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files && importFile.files[0];
    importFile.value = ""; // allow re-selecting the same file later
    if (file) await importYearFromFile(file);
  });

  /* ------------------------------------------------------------------ *
   * 12. STORAGE HEALTH — persistent-storage request + quota warning
   *    - Requests "persistent" storage so the browser is less likely to
   *      silently evict this diary's data under disk pressure.
   *    - Periodically checks how full the storage quota is and shows a
   *      dismissible banner nudging the user to export a backup before
   *      they lose the ability to save new entries.
   * ------------------------------------------------------------------ */
  const storageWarningEl = document.getElementById("storageWarning");
  const storageWarningTextEl = document.getElementById("storageWarningText");

  async function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        await navigator.storage.persist();
      }
    } catch (e) { /* not critical — best effort only */ }
  }

  async function checkStorageHealth() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return;
      const { usage, quota } = await navigator.storage.estimate();
      if (!quota) return;
      const ratio = usage / quota;
      if (ratio > 0.8) {
        const pct = Math.round(ratio * 100);
        storageWarningTextEl.textContent =
          `Storage is ${pct}% full. Export a backup soon so you don't lose new entries.`;
        storageWarningEl.classList.remove("hidden");
      } else {
        storageWarningEl.classList.add("hidden");
      }
    } catch (e) { /* best effort only */ }
  }

  document.getElementById("storageWarningDismiss").addEventListener("click", () => {
    storageWarningEl.classList.add("hidden");
  });

  /* ------------------------------------------------------------------ *
   * 13. INIT
   * ------------------------------------------------------------------ */
  function init() {
    renderHome();
    refreshContentDots();
    setMode("pen");
    updateHistoryButtons();
    requestPersistentStorage();
    checkStorageHealth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
