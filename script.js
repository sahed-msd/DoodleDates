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
     9. AUTO-SAVE — debounced + event-driven persistence
     10. INIT
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

  function pointerMoveOnCanvas(e) {
    if (activeStroke === null || e.pointerId !== drawingPointerId) return;
    activeStroke.points.push(relPointFromEvent(e));
    // Redraw just enough: full clear+replay keeps erase compositing correct
    // (destination-out must see everything beneath it, including this month's
    // earlier strokes) while staying cheap for typical diary-length pages.
    redrawCanvas();
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
   * ------------------------------------------------------------------ */
  function createNoteElement(note) {
    const el = document.createElement("div");
    el.className = "sticky-note";
    el.style.left = `${note.xPct}%`;
    el.style.top = `${note.yPct}%`;
    if (note.widthPx) el.style.width = `${note.widthPx}px`;
    el.dataset.id = note.id;

    const del = document.createElement("button");
    del.className = "note-del";
    del.type = "button";
    del.title = "Delete note";
    del.textContent = "×";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      monthState.notes = monthState.notes.filter(n => n.id !== note.id);
      el.remove();
      scheduleSave();
    });
    el.appendChild(del);

    const text = document.createElement("div");
    text.className = "note-text";
    text.contentEditable = "true";
    text.style.color = note.color || currentColor;
    text.textContent = note.text || "";
    text.addEventListener("input", () => {
      note.text = text.textContent;
      scheduleSave();
    });
    // Prevent the drawing canvas (or note dragging) from stealing clicks
    // meant for text editing.
    text.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    el.appendChild(text);

    // Dragging: pointerdown anywhere on the note *except* the editable text
    // or delete button repositions it. Position stored back as percentages.
    let dragging = false, startX = 0, startY = 0, startLeftPct = 0, startTopPct = 0;
    el.addEventListener("pointerdown", (ev) => {
      if (ev.target === text || ev.target === del) return;
      dragging = true;
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
    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("dragging");
      scheduleSave();
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);

    return el;
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
    const note = { id: uid(), xPct, yPct, widthPx: 180, text: "", color: currentColor };
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
    if (!confirm(`Clear all ink and notes from ${MONTH_NAMES[currentMonth]}? This can't be undone.`)) return;
    monthState = { strokes: [], notes: [] };
    redrawCanvas();
    rebuildNotesDOM();
    scheduleSave();
  });

  /* ------------------------------------------------------------------ *
   * 9. AUTO-SAVE — zero manual save buttons
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
   * 10. INIT
   * ------------------------------------------------------------------ */
  function init() {
    renderHome();
    refreshContentDots();
    setMode("pen");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
