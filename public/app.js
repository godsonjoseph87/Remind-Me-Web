/* RemindMe Dashboard — frontend application */

const BASE_PATH = window.location.pathname.startsWith('/remind-me') ? '/remind-me' : '';
const API = BASE_PATH;
const ALL_DAY_HOUR = 9;
let meta = {};
let reminders = [];
let currentFilter = "all";
let searchQuery = "";
let selectedColor = "#6366f1";
let selectedTone = "chime";
let selectedDays = new Set();
let snoozeTargetId = null;
let currentView = "list";
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;
let calSelectedDay = null;
let calendarData = { days: {} };
let googleStatus = {};
let googleEventToneSaved = "chime";
let googleSigninPoll = null;
let oauthSetupGuide = null;
let lastRemindersFingerprint = "";
let lastGoogleStatusFingerprint = "";
let lastCalendarFingerprint = "";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function dataFingerprint(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function markListSettled() {
  const grid = $("#reminder-list");
  if (grid) grid.classList.add("list-settled");
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function parseLocalDateTime(iso) {
  if (!iso) return null;
  const trimmed = String(iso).trim();
  if (/[Zz]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed.replace(" ", "T"))) {
    const d = new Date(trimmed.replace(" ", "T"));
    return isNaN(d) ? null : d;
  }
  const clean = trimmed.replace(" ", "T");
  const [datePart, timePart = "00:00:00"] = clean.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [hh, mm, ss = 0] = timePart.split(":");
  const dt = new Date(y, mo - 1, d, Number(hh), Number(mm), Number(String(ss).slice(0, 2)));
  return isNaN(dt.getTime()) ? null : dt;
}

const LOCALE_12H = "en-US";
const TIME_12_OPTS = { hour: "numeric", minute: "2-digit", hour12: true };
const DATE_TIME_12_OPTS = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
};

function fmtTime12FromDate(d) {
  if (!d || isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(LOCALE_12H, TIME_12_OPTS);
}

function fmtTime12FromClock(timeStr) {
  if (!timeStr) return "—";
  const [h, m = "0"] = String(timeStr).trim().split(":");
  const hour = parseInt(h, 10);
  const minute = parseInt(m, 10);
  if (Number.isNaN(hour)) return timeStr;
  return fmtTime12FromDate(new Date(2000, 0, 1, hour, minute));
}

function fmtTime12(isoOrClock) {
  if (!isoOrClock) return "—";
  if (/^\d{1,2}:\d{2}/.test(String(isoOrClock).trim())) {
    return fmtTime12FromClock(isoOrClock);
  }
  return fmtTime12FromDate(parseLocalDateTime(isoOrClock));
}

function fmtDate(iso, allDay = false) {
  if (!iso) return "—";
  if (allDay) {
    const [y, mo, d] = iso.slice(0, 10).split("-").map(Number);
    const day = new Date(y, mo - 1, d);
    if (isNaN(day)) return iso;
    return day.toLocaleDateString(LOCALE_12H, { month: "short", day: "numeric", year: "numeric" }) + " · All day";
  }
  const d = parseLocalDateTime(iso);
  if (!d) return iso;
  return d.toLocaleString(LOCALE_12H, DATE_TIME_12_OPTS);
}

function typeLabel(type) {
  return (meta.types && meta.types.find(function(t) { return t.id === type; }) || {}).label || type;
}

function typeIcon(type) {
  return (meta.types && meta.types.find(function(t) { return t.id === type; }) || {}).icon || "📋";
}

function relativeNext(iso) {
  if (!iso) return "";
  const d = parseLocalDateTime(iso);
  if (!d) return "";
  const diff = d - Date.now();
  if (diff < 0) return " · overdue";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return ` · in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return ` · in ${hrs}h`;
  return "";
}

async function loadMeta() {
  meta = await api("/api/meta");
  populateFormMeta();
  populateGoogleToneSelect();
  syncGoogleToneFromStatus();
}

function populateGoogleToneSelect() {
  const select = $("#google-event-tone");
  if (!select || !(meta.tones && meta.tones.length)) return;
  const current = select.value || googleEventToneSaved;
  select.innerHTML = meta.tones
    .map(
      (t) =>
        `<option value="${escAttr(t.id)}">${t.emoji} ${esc(t.name)}</option>`
    )
    .join("");
  if (current && meta.tones.some((t) => t.id === current)) {
    select.value = current;
  }
}

function updateGoogleToneBarVisibility() {
  const bar = $("#google-tone-bar");
  if (!bar) return;
  const show = currentFilter === "GOOGLE" && currentView !== "guide";
  bar.classList.toggle("hidden", !show);
}

function syncGoogleToneFromStatus() {
  const tone = (googleStatus.reminder_settings && googleStatus.reminder_settings.tone) || googleEventToneSaved || "chime";
  googleEventToneSaved = tone;
  const select = $("#google-event-tone");
  if (select && (meta.tones && meta.tones.some(function(t) { return t.id === tone; }))) {
    select.value = tone;
  }
  updateGoogleToneSaveState();
  updateGoogleToneSavedHint();
}

function updateGoogleToneSaveState() {
  const select = $("#google-event-tone");
  const saveBtn = $("#btn-google-tone-save");
  if (!select || !saveBtn) return;
  saveBtn.disabled = select.value === googleEventToneSaved;
}

function updateGoogleToneSavedHint() {
  const hint = $("#google-tone-saved-hint");
  if (!hint) return;
  const name = toneName(googleEventToneSaved);
  const emoji = toneEmoji(googleEventToneSaved);
  hint.textContent = `Saved: ${emoji} ${name} — used for Google Calendar events and Tasks reminders`;
}

async function saveGoogleEventTone() {
  const select = $("#google-event-tone");
  const saveBtn = $("#btn-google-tone-save");
  if (!select) return;
  const tone = select.value;
  try {
    saveBtn.disabled = true;
    const result = await api("/api/google/reminder-settings", {
      method: "PUT",
      body: JSON.stringify({ tone }),
    });
    googleEventToneSaved = result.tone;
    if (!googleStatus.reminder_settings) googleStatus.reminder_settings = {};
    googleStatus.reminder_settings.tone = result.tone;
    updateGoogleToneSaveState();
    updateGoogleToneSavedHint();
    toast(`Google reminder tone saved: ${toneEmoji(result.tone)} ${toneName(result.tone)}`);
  } catch (err) {
    toast(err.message || "Failed to save tone", "error");
    updateGoogleToneSaveState();
  }
}

// ==========================================
// Web Audio API Synthesizer & Sound Player
// ==========================================

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

// Unlock audio on first user gesture
document.addEventListener("click", () => { getAudioContext(); }, { once: true });
document.addEventListener("keydown", () => { getAudioContext(); }, { once: true });

function playBellHarmonics(ctx, fundamental, start, duration, volume) {
  const partials = [[1.0, 1.0], [2.0, 0.45], [3.0, 0.22], [4.2, 0.1]];
  partials.forEach(([mult, weight]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(fundamental * mult, start);
    gain.gain.setValueAtTime(volume * weight * 0.4, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration);
  });
}

function playAudioElementFallback(toneId) {
  try {
    const player = document.getElementById("audio-player");
    if (player) {
      player.src = `${API}/api/tones/${encodeURIComponent(toneId)}/wav`;
      player.play().catch(() => {});
    }
  } catch (e) {}
}

function playWebAudioTone(toneId) {
  if (!toneId || toneId === "silent") return;
  const ctx = getAudioContext();
  if (!ctx) {
    playAudioElementFallback(toneId);
    return;
  }
  const now = ctx.currentTime;

  try {
    if (toneId === "chime") {
      playBellHarmonics(ctx, 523.25, now, 0.55, 0.35);      // C5
      playBellHarmonics(ctx, 659.25, now + 0.65, 0.65, 0.38); // E5
      playBellHarmonics(ctx, 783.99, now + 1.4, 1.0, 0.42);   // G5
      return;
    }

    if (toneId === "bell") {
      const partials = [[660, 0.3], [990, 0.2], [1320, 0.1]];
      partials.forEach(([f, vol]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(f, now);
        gain.gain.setValueAtTime(vol * 0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 1.2);
      });
      return;
    }

    if (toneId === "gentle") {
      for (let i = 0; i < 3; i++) {
        const t = now + i * 0.43;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(440, t);
        gain.gain.setValueAtTime(0.001, t);
        gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.26);
      }
      return;
    }

    if (toneId === "urgent") {
      for (let i = 0; i < 4; i++) {
        const t = now + i * 0.19;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(1200, t);
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.setValueAtTime(0.0001, t + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.13);
      }
      return;
    }

    if (toneId === "digital") {
      const freqs = [[1567.98, 0, 0.15], [2093, 0.15, 0.15]];
      freqs.forEach(([f, delay, dur]) => {
        const t = now + delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(f, t);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur);
      });
      return;
    }

    if (toneId === "zen") {
      [220, 196, 174.61].forEach((f, idx) => {
        const t = now + idx * 0.95;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(f, t);
        gain.gain.setValueAtTime(0.35, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.95);
      });
      return;
    }

    if (toneId === "birds") {
      [1800, 2200, 2000, 2600].forEach((f, idx) => {
        const t = now + idx * 0.12;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(f, t);
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.09);
      });
      return;
    }
  } catch (err) {
    console.warn("Web Audio synthesis error, falling back to audio element:", err);
  }

  playAudioElementFallback(toneId);
}

async function previewGoogleEventTone() {
  const tone = ($("#google-event-tone") ? $("#google-event-tone").value : "") || googleEventToneSaved;
  playWebAudioTone(tone);
  try {
    await api("/api/tones/preview", {
      method: "POST",
      body: JSON.stringify({ tone }),
    });
  } catch {}
}

async function loadStats() {
  const s = await api("/api/stats");
  $("#stat-active").textContent = s.active;
  $("#stat-snoozed").textContent = s.snoozed;
  $("#stat-total").textContent = s.total;
}

async function loadReminders(opts = {}) {
  const silent = opts.silent === true;
  try {
    if (currentFilter === "GOOGLE") {
      const next = await api("/api/reminders?source=google");
      const fingerprint = dataFingerprint(next);
      const unchanged = silent && fingerprint === lastRemindersFingerprint;
      reminders = next;
      if (!unchanged) {
        lastRemindersFingerprint = fingerprint;
        if (currentView === "guide") {
          switchView("list");
        } else if (currentView === "list") {
          renderGoogleItems();
        } else {
          await loadCalendar({ silent });
        }
      }
      loadStats();
      return;
    }

    const params = currentFilter === "all" ? "" : `?status=${currentFilter}`;
    const next = await api(`/api/reminders${params}`);
    const fingerprint = dataFingerprint(next);
    const unchanged = silent && fingerprint === lastRemindersFingerprint;
    reminders = next;
    if (!unchanged) {
      lastRemindersFingerprint = fingerprint;
      if (currentView === "list") {
        renderReminders();
      } else if (currentView !== "guide") {
        await loadCalendar({ silent });
      }
    }
    loadStats();
  } catch (err) {
    if (!silent) toast(err.message || "Failed to load reminders", "error");
  }
}

function pageTitleForFilter(filter) {
  const titles = {
    all: "All Reminders",
    PENDING: "Active Reminders",
    SNOOZED: "Snoozed",
    DISMISSED: "Dismissed",
    GOOGLE: "Google Calendar & Tasks",
  };
  return titles[filter] || "Reminders";
}

function pageSubtitleForFilter(filter) {
  if (filter === "GOOGLE") return "Synced Google Calendar events and Tasks";
  if (filter === "PENDING") return "Reminders waiting to fire";
  if (filter === "SNOOZED") return "Snoozed reminders";
  if (filter === "DISMISSED") return "Dismissed reminders";
  if (filter === "all") {
    return searchQuery
      ? "Manage your scheduled reminders"
      : "Drag cards to prioritise · manage your scheduled reminders";
  }
  return "Manage your scheduled reminders";
}

function canReorderReminders() {
  return currentFilter === "all" && currentView === "list" && !searchQuery;
}

let draggedReminderId = null;

function initReminderDragDrop() {
  const grid = $("#reminder-list");
  if (!grid || !canReorderReminders()) return;

  grid.querySelectorAll(".card-drag-handle").forEach((handle) => {
    handle.addEventListener("dragstart", onReminderDragStart);
    handle.addEventListener("dragend", onReminderDragEnd);
  });

  grid.querySelectorAll(".reminder-card.reorderable").forEach((card) => {
    card.addEventListener("dragover", onReminderDragOver);
    card.addEventListener("dragleave", onReminderDragLeave);
    card.addEventListener("drop", onReminderDrop);
  });
}

function onReminderDragStart(e) {
  const card = e.currentTarget.closest(".reminder-card");
  if (!card) return;
  draggedReminderId = card.dataset.id;
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedReminderId);
}

function onReminderDragEnd() {
  draggedReminderId = null;
  $$(".reminder-card.dragging, .reminder-card.drag-over").forEach((el) => {
    el.classList.remove("dragging", "drag-over");
  });
}

function onReminderDragOver(e) {
  if (!draggedReminderId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const card = e.currentTarget.closest(".reminder-card");
  if (card && card.dataset.id !== draggedReminderId) {
    card.classList.add("drag-over");
  }
}

function onReminderDragLeave(e) {
  const card = e.currentTarget.closest(".reminder-card");
  if (card) card.classList.remove("drag-over");
}

async function onReminderDrop(e) {
  e.preventDefault();
  const targetCard = e.currentTarget.closest(".reminder-card");
  if (targetCard) targetCard.classList.remove("drag-over");
  if (!draggedReminderId || !targetCard) return;

  const grid = $("#reminder-list");
  const srcCard = grid.querySelector(`.reminder-card[data-id="${draggedReminderId}"]`);
  if (!srcCard || srcCard === targetCard) return;

  const cards = [...grid.querySelectorAll(".reminder-card[data-id]")];
  const srcIdx = cards.indexOf(srcCard);
  const tgtIdx = cards.indexOf(targetCard);
  grid.insertBefore(srcCard, srcIdx < tgtIdx ? targetCard.nextSibling : targetCard);

  await persistReminderOrder();
}

async function persistReminderOrder() {
  const grid = $("#reminder-list");
  const order = [...grid.querySelectorAll(".reminder-card[data-id]")].map(
    (card) => card.dataset.id
  );
  try {
    const updated = await api("/api/reminders/reorder", {
      method: "POST",
      body: JSON.stringify({ order }),
    });
    const orderMap = new Map(updated.map((r) => [r.id, (r.sort_order !== undefined && r.sort_order !== null ? r.sort_order : 0)]));
    reminders = reminders
      .map((r) => ({ ...r, sort_order: (orderMap.get(r.id) != null ? orderMap.get(r.id) : (r.sort_order != null ? r.sort_order : 0)) }))
      .sort((a, b) => ((a.sort_order != null ? a.sort_order : 0) - (b.sort_order != null ? b.sort_order : 0)));
  } catch (err) {
    toast(err.message || "Failed to save order", "error");
    renderReminders();
  }
}

function selectNavFilter(filter) {
  currentFilter = filter;
  lastRemindersFingerprint = "";
  lastCalendarFingerprint = "";
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.filter === filter));
  $("#btn-new").classList.toggle("hidden", filter === "GOOGLE");
  updateGoogleToneBarVisibility();

  if (filter === "GOOGLE" && currentView !== "list") {
    switchView("list");
  } else {
    $("#page-title").textContent = pageTitleForFilter(filter);
    $("#page-subtitle").textContent = pageSubtitleForFilter(filter);
    loadReminders();
  }
}

const GOOGLE_HTML_ALLOWED = new Set([
  "P", "BR", "STRONG", "B", "EM", "I", "UL", "OL", "LI", "A",
  "H1", "H2", "H3", "H4", "DIV", "SPAN", "U", "HR", "BLOCKQUOTE",
]);

let googleItemsById = {};

function sanitizeGoogleHtml(raw) {
  if (!raw) return "";
  if (!/<[a-z][\s\S]*>/i.test(raw)) {
    return esc(raw).replace(/\n/g, "<br>");
  }
  const doc = new DOMParser().parseFromString(raw, "text/html");

  function clean(node) {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) return;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        return;
      }
      const tag = child.tagName;
      if (!GOOGLE_HTML_ALLOWED.has(tag)) {
        const parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        child.remove();
        return;
      }
      [...child.attributes].forEach((attr) => {
        if (tag === "A" && attr.name.toLowerCase() === "href") {
          const href = attr.value.trim();
          if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) {
            child.removeAttribute("href");
          }
        } else {
          child.removeAttribute(attr.name);
        }
      });
      if (tag === "A" && child.getAttribute("href")) {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }
      clean(child);
    });
  }

  clean(doc.body);
  return doc.body.innerHTML.trim();
}

function htmlToPlainText(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = sanitizeGoogleHtml(html);
  return div.textContent.replace(/\s+/g, " ").trim();
}

function htmlToPlainPreview(html, maxLen = 100) {
  const text = htmlToPlainText(html);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen).trim()}…`;
}

function openGoogleDetail(id) {
  const item = googleItemsById[id];
  if (!item) return;

  $("#google-detail-title").textContent = item.title;
  const metaParts = [
    googleSourceLabel(item.source),
    item.start_time ? fmtDate(item.start_time, item.all_day) : "No due date",
  ];
  if (item.silent) metaParts.push("🔇 Silenced");
  $("#google-detail-meta").textContent = metaParts.join(" · ");

  const body = $("#google-detail-body");
  if (item.description) {
    body.innerHTML = sanitizeGoogleHtml(item.description);
    body.classList.remove("empty");
  } else {
    body.textContent = "No description provided.";
    body.classList.add("empty");
  }

  const openLink = $("#google-detail-open");
  if (item.html_link) {
    openLink.href = item.html_link;
    openLink.classList.remove("hidden");
  } else {
    openLink.classList.add("hidden");
  }

  const acceptBtn = $("#google-detail-accept-btn");
  const rejectBtn = $("#google-detail-reject-btn");
  if (acceptBtn) {
    acceptBtn.onclick = async () => {
      await acceptGoogleItem(id);
      closeGoogleDetail();
    };
  }
  if (rejectBtn) {
    rejectBtn.onclick = async () => {
      await rejectGoogleItem(id);
      closeGoogleDetail();
    };
  }

  $("#google-detail-overlay").classList.remove("hidden");
}

function closeGoogleDetail() {
  $("#google-detail-overlay").classList.add("hidden");
  $("#google-detail-body").innerHTML = "";
}

function isGoogleItemVisible(item) {
  if (!item || !item.start_time) return true;
  const key = eventDateKey(item.start_time);
  return key >= localDateKey();
}

function filteredGoogleItems() {
  const visible = reminders.filter(isGoogleItemVisible);
  if (!searchQuery) return visible;
  const q = searchQuery.toLowerCase();
  return visible.filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      htmlToPlainText(r.description).toLowerCase().includes(q)
  );
}

function formatReminderOffsets(offsets) {
  const list = offsets || [10, 5, 0];
  const parts = [];
  list.filter((o) => o > 0).sort((a, b) => b - a).forEach((o) => parts.push(`${o} min`));
  if (list.some((o) => o === 0)) parts.push("at event time");
  return parts.join(" · ");
}

function googleSourceLabel(source) {
  if (source === "google_calendar") return "Google Calendar";
  if (source === "google_tasks") return "Google Tasks";
  if (source === "ical") return "Calendar link";
  return source;
}

function googleSourceIcon(source) {
  if (source === "google_calendar" || source === "ical") return "📅";
  return "✓";
}

function googleAccent(source) {
  if (source === "google_calendar") return "#4285f4";
  if (source === "ical") return "#9333ea";
  return "#34a853";
}

const GOOGLE_EXPIRED_ACCENT = "#ef4444";

function isGoogleEventExpired(item) {
  if (!item || !item.start_time) return false;

  const now = Date.now();
  const start = parseEventDate(item.start_time);
  if (!start) return false;

  if (item.all_day) {
    const end = item.end_time ? parseEventDate(item.end_time) : null;
    if (end) return now >= end.getTime();
    const dayEnd = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      23,
      59,
      59,
      999
    );
    return now > dayEnd.getTime();
  }

  const end = item.end_time ? parseEventDate(item.end_time) : null;
  if (end) return now >= end.getTime();

  return now >= start.getTime();
}

function googleCardAccent(item) {
  return isGoogleEventExpired(item) ? GOOGLE_EXPIRED_ACCENT : googleAccent(item.source);
}

function supportsGoogleAddress(item) {
  return (
    !!(item && item.start_time) &&
    (item.source === "google_calendar" || item.source === "google_tasks")
  );
}

function isGoogleEventStarted(item) {
  if (item && typeof item.started === "boolean") return item.started;
  if (!item || !item.start_time) return false;
  const start = parseEventDate(item.start_time);
  if (!start) return false;
  if (item.all_day) {
    const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0, 0, 0);
    return Date.now() >= dayStart.getTime();
  }
  return Date.now() >= start.getTime();
}

function googleNeedsAddress(item) {
  return (
    supportsGoogleAddress(item) &&
    !item.silent &&
    !item.addressed &&
    (item.in_nudge_window != null ? item.in_nudge_window : isGoogleEventInNudgeWindow(item))
  );
}

function isGoogleEventInNudgeWindow(item) {
  if (!supportsGoogleAddress(item) || !item.start_time) return false;
  const now = new Date();
  const todayKey = localDateKey(now);
  if (eventDateKey(item.start_time) !== todayKey) return false;

  const start = parseEventDate(item.start_time);
  if (!start) return false;

  let end;
  if (item.end_time) {
    end = parseEventDate(item.end_time);
    if (item.all_day && end) {
      end = new Date(end.getTime() - 1000);
    }
  } else if (item.all_day) {
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999);
    start.setHours(9, 0, 0, 0);
  } else {
    end = new Date(start.getTime() + 60 * 60 * 1000);
    const dayEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999);
    if (end > dayEnd) end = dayEnd;
  }

  if (!end) return false;
  const nowMs = now.getTime();
  return nowMs >= start.getTime() && nowMs <= end.getTime();
}

function renderGoogleAddressButton(item) {
  if (!supportsGoogleAddress(item)) return "";
  if (item.addressed) {
    return `<button type="button" class="btn-sm google-addressed" title="Addressed" disabled>✓</button>`;
  }
  if (isGoogleEventInNudgeWindow(item) || item.in_nudge_window) {
    return `<button type="button" class="btn-sm google-address-pending" data-address-toggle="${escAttr(item.id)}" title="Mark as addressed">✓</button>`;
  }
  if (isGoogleEventStarted(item)) {
    return `<button type="button" class="btn-sm google-address-later" title="Available during event time" disabled>✓</button>`;
  }
  return "";
}

function renderUrgentAddressButton(r) {
  if (!r.urgent_addressable) return "";
  if (r.urgent_addressed) {
    return `<button type="button" class="btn-sm google-addressed" title="Addressed" disabled>✓</button>`;
  }
  if (r.in_urgent_nudge_window) {
    return `<button type="button" class="btn-sm google-address-pending" data-urgent-address="${escAttr(r.id)}" title="Mark as addressed">✓</button>`;
  }
  return "";
}

function parseEventDate(iso) {
  return parseLocalDateTime(iso);
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function eventDateKey(iso) {
  const d = parseEventDate(iso);
  if (!d) return null;
  return localDateKey(d);
}

function googleDayLabel(dateKey) {
  const todayKey = localDateKey();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = localDateKey(tomorrow);

  if (dateKey === todayKey) return "Today";
  if (dateKey === tomorrowKey) return "Tomorrow";

  const today = new Date();
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const opts = { weekday: "long", month: "short", day: "numeric" };
  if (y !== today.getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(undefined, opts);
}

function fmtEventTime(iso, allDay = false) {
  if (!iso) return "—";
  if (allDay) return "All day";
  return fmtTime12(iso);
}

function fmtGoogleTimeRange(item) {
  if (!item || !item.start_time) return null;
  if (item.all_day) return "All day";

  const start = fmtEventTime(item.start_time, false);
  if (!item.end_time) return start;

  const end = fmtEventTime(item.end_time, false);
  if (end === start) return start;
  return `${start} - ${end}`;
}

function fmtGoogleWhen(item, grouped) {
  if (!item.start_time) return "<strong>No due date</strong>";

  if (grouped) {
    const range = fmtGoogleTimeRange(item) || fmtEventTime(item.start_time, item.all_day);
    return `<strong>${range}</strong>${relativeNext(item.start_time)}`;
  }

  if (item.all_day) {
    return `<strong>${fmtDate(item.start_time, true)}</strong>${relativeNext(item.start_time)}`;
  }

  const startDate = fmtDate(item.start_time, false);
  const startTime = fmtEventTime(item.start_time, false);
  if (item.end_time) {
    const startDay = eventDateKey(item.start_time);
    const endDay = eventDateKey(item.end_time);
    const endTime = fmtEventTime(item.end_time, false);
    if (startDay && endDay && startDay === endDay && endTime !== startTime) {
      return `<strong>${startDate.replace(startTime, `${startTime} - ${endTime}`)}</strong>${relativeNext(item.start_time)}`;
    }
  }

  return `<strong>${startDate}</strong>${relativeNext(item.start_time)}`;
}

function groupGoogleItemsByDate(list) {
  const dated = new Map();
  const noDate = [];

  for (const item of list) {
    const key = eventDateKey(item.start_time);
    if (!key) {
      noDate.push(item);
      continue;
    }
    if (!dated.has(key)) dated.set(key, []);
    dated.get(key).push(item);
  }

  const sections = [...dated.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, items]) => ({
      key,
      label: googleDayLabel(key),
      items: items.sort((a, b) => (a.start_time || "").localeCompare(b.start_time || "")),
    }));

  noDate.sort((a, b) => a.title.localeCompare(b.title));
  return { sections, noDate };
}

function renderGoogleCard(r, i, grouped = false) {
  const expired = isGoogleEventExpired(r);
  const needsAddress = googleNeedsAddress(r);
  const whenText = fmtGoogleWhen(r, grouped);
  const isAccepted = r.status === 'accepted' || r.status === 'completed';
  const isDeclined = r.status === 'declined' || r.status === 'cancelled';
  const isTask = r.source === 'google_tasks';

  // Check for Google Meet link
  let meetLink = r.meet_link || null;
  if (!meetLink && r.html_link && r.html_link.includes('meet.google.com')) {
    meetLink = r.html_link;
  }
  if (!meetLink && r.description) {
    const m = r.description.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i);
    if (m) meetLink = m[0];
  }

  return `
    <article class="reminder-card google-card${r.silent ? " google-silent" : ""}${expired ? " google-expired" : ""}${needsAddress ? " google-needs-address" : ""}${r.addressed ? " google-addressed-card" : ""}${isAccepted ? " google-accepted-card" : ""}" style="--card-accent: ${googleCardAccent(r)}; animation-delay: ${i * 0.03}s">
      <div class="card-header">
        <div class="card-title" title="${esc(r.title)}">${meetLink ? '📹 ' : ''}${googleSourceIcon(r.source)} ${esc(r.title)}</div>
        <div class="card-header-badges">
          ${isAccepted ? `<span class="badge badge-accepted">✓ ${isTask ? 'Completed' : 'Accepted'}</span>` : ''}
          ${isDeclined ? `<span class="badge badge-declined">✕ Declined</span>` : ''}
          <span class="badge ${r.source === "google_calendar" ? "google-badge" : "google-tasks-badge"}${expired ? " google-expired-badge" : ""}">${googleSourceLabel(r.source)}</span>
        </div>
      </div>
      ${r.description ? `<p class="google-card-preview">${esc(htmlToPlainPreview(r.description, 90))}</p>` : ""}
      <div class="card-next google-card-when">
        ${whenText}
        ${expired ? `<span class="card-hint expired-hint"> · Expired</span>` : ""}
        ${needsAddress ? `<span class="card-hint address-hint"> · Tap ✓ when addressed</span>` : ""}
        ${r.start_time && !r.silent && !expired && !needsAddress ? `<span class="card-hint"> · ${formatReminderOffsets(r.reminder_offsets)}</span>` : ""}
        ${r.silent ? `<span class="card-hint silent-hint"> · 🔇 Silent</span>` : ""}
      </div>
      <div class="card-actions google-card-actions">
        ${!isAccepted ? `<button type="button" class="btn-sm success" data-google-accept="${escAttr(r.id)}" title="${isTask ? 'Accept / Mark complete' : 'Accept invite (RSVP Yes)'}">✓ Accept</button>` : ''}
        ${!isDeclined && !isAccepted ? `<button type="button" class="btn-sm danger" data-google-reject="${escAttr(r.id)}" title="${isTask ? 'Reject / Delete task' : 'Decline invite (RSVP No)'}">✕ Reject</button>` : ''}
        ${renderGoogleAddressButton(r)}
        ${meetLink ? `<a class="btn-sm meet-join-btn" href="${esc(meetLink)}" target="_blank" rel="noopener" title="Join Google Meet Call">📹 Join Call</a>` : ''}
        ${r.description ? `<button type="button" class="btn-sm" data-google-detail="${escAttr(r.id)}">Details</button>` : ""}
        ${r.start_time ? `<button type="button" class="btn-sm ${r.silent ? "active" : ""}" data-silent-toggle="${escAttr(r.id)}">${r.silent ? "🔇" : "🔔"}</button>` : ""}
        ${r.html_link ? `<button type="button" class="btn-sm primary google-open" data-link="${encodeURIComponent(r.html_link)}" title="Open in Google">↗</button>` : ""}
      </div>
    </article>`;
}

async function acceptGoogleItem(itemId) {
  try {
    const res = await api(`/api/google/items/${encodeURIComponent(itemId)}/accept`, {
      method: "POST"
    });
    toast(res.status === "completed" ? "Task accepted & completed ✓" : "Invitation accepted (RSVP Yes) ✓");
    await loadReminders({ silent: true });
  } catch (err) {
    toast(err.message || "Failed to accept item", "error");
  }
}

async function rejectGoogleItem(itemId) {
  if (!confirm("Are you sure you want to decline / reject this item?")) return;
  try {
    const res = await api(`/api/google/items/${encodeURIComponent(itemId)}/reject`, {
      method: "POST"
    });
    toast(res.status === "deleted" ? "Task rejected & removed ✕" : "Invitation declined (RSVP No) ✕");
    await loadReminders({ silent: true });
  } catch (err) {
    toast(err.message || "Failed to reject item", "error");
  }
}

function renderGoogleItems() {
  const list = filteredGoogleItems();
  const grid = $("#reminder-list");
  const empty = $("#empty-state");

  googleItemsById = Object.fromEntries(list.map((r) => [r.id, r]));
  grid.classList.add("google-grid");

  if (list.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    if (googleStatus.last_error && googleStatus.last_error.includes("Google Calendar API has not been used")) {
      empty.querySelector("h3").textContent = "Google Calendar API Not Enabled";
      empty.querySelector("p").innerHTML = `Google Cloud reported that the Google Calendar API is disabled for project 650114836552.<br><br>
        <a href="https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=650114836552" target="_blank" rel="noopener" style="display:inline-block; margin-top:8px; padding:8px 16px; background:#4285f4; color:#ffffff; border-radius:8px; text-decoration:none; font-weight:600; box-shadow:0 2px 4px rgba(66,133,244,0.3);">
          🔗 Enable Google Calendar API
        </a>
        <br><br>
        <span style="font-size:0.8rem; color:var(--text-muted, #94a3b8);">After clicking Enable in Google Cloud Console, refresh this page to sync all events.</span>`;
    } else {
      empty.querySelector("h3").textContent = googleStatus.connected
        ? "No synced Google items"
        : "Connect Google to see events";
      empty.querySelector("p").textContent = googleStatus.connected
        ? (googleStatus.last_error ? `Sync notice: ${googleStatus.last_error}` : "Try syncing or check your calendar and tasks in Google")
        : "Click Setup guide in the sidebar to connect Google";
    }
    markListSettled();
    return;
  }

  empty.classList.add("hidden");
  const { sections, noDate } = groupGoogleItemsByDate(list);
  let cardIndex = 0;

  const sectionHtml = sections.map(({ key, label, items }) => {
    const cards = items.map((r) => renderGoogleCard(r, cardIndex++, true)).join("");
    const countLabel = items.length === 1 ? "1 item" : `${items.length} items`;
    return `
      <section class="google-day-section" data-day="${key}">
        <header class="google-day-header">
          <h3 class="google-day-title">${esc(label)}</h3>
          <span class="google-day-count">${countLabel}</span>
        </header>
        <div class="google-day-grid">${cards}</div>
      </section>`;
  }).join("");

  const noDateHtml = noDate.length
    ? `
      <section class="google-day-section google-day-section-undated">
        <header class="google-day-header">
          <h3 class="google-day-title">No due date</h3>
          <span class="google-day-count">${noDate.length === 1 ? "1 task" : `${noDate.length} tasks`}</span>
        </header>
        <div class="google-day-grid">${noDate.map((r) => renderGoogleCard(r, cardIndex++, false)).join("")}</div>
      </section>`
    : "";

  grid.innerHTML = sectionHtml + noDateHtml;

  grid.querySelectorAll("[data-google-accept]").forEach((btn) => {
    btn.addEventListener("click", () => acceptGoogleItem(btn.getAttribute("data-google-accept")));
  });

  grid.querySelectorAll("[data-google-reject]").forEach((btn) => {
    btn.addEventListener("click", () => rejectGoogleItem(btn.getAttribute("data-google-reject")));
  });

  grid.querySelectorAll("[data-silent-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => toggleGoogleSilent(btn.getAttribute("data-silent-toggle")));
  });

  grid.querySelectorAll("[data-address-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => markGoogleAddressed(btn.getAttribute("data-address-toggle")));
  });
  markListSettled();
}

function escAttr(s) {
  return String(s).replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".google-open");
  if (btn && btn.dataset.link) {
    window.open(decodeURIComponent(btn.dataset.link), "_blank", "noopener");
    return;
  }
  const detailBtn = e.target.closest("[data-google-detail]");
  if (detailBtn && detailBtn.dataset.googleDetail) {
    openGoogleDetail(detailBtn.dataset.googleDetail);
  }
});

function filteredReminders() {
  if (!searchQuery) return reminders;
  const q = searchQuery.toLowerCase();
  return reminders.filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q)
  );
}

function renderReminders() {
  const list = filteredReminders();
  const grid = $("#reminder-list");
  const empty = $("#empty-state");
  const reorderable = canReorderReminders();

  grid.classList.remove("google-grid");

  if (list.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    markListSettled();
    return;
  }

  empty.classList.add("hidden");
  grid.innerHTML = list
    .map(
      (r, i) => {
        const needsUrgentAddress = r.urgent_addressable && r.in_urgent_nudge_window && !r.urgent_addressed;
        const urgentAddressed = r.urgent_addressable && r.urgent_addressed;
        return `
    <article class="reminder-card${reorderable ? " reorderable" : ""}${needsUrgentAddress ? " urgent-needs-address" : ""}${urgentAddressed ? " urgent-addressed-card" : ""}" data-id="${r.id}" style="--card-accent: ${r.color}; animation-delay: ${i * 0.05}s">
      ${
        reorderable
          ? `<button type="button" class="card-drag-handle" draggable="true" aria-label="Drag to reorder" title="Drag to prioritise">⋮⋮</button>`
          : ""
      }
      <div class="card-header">
        <div class="card-title">${typeIcon(r.type)} ${esc(r.title)}</div>
        <span class="badge status-${r.status}">${r.status}</span>
      </div>
      ${r.description ? `<p class="card-desc">${esc(r.description)}</p>` : ""}
      <div class="card-meta">
        <span class="badge">${typeLabel(r.type)}</span>
        ${r.until_dismissed && r.status !== "TRIGGERED" ? `<span class="badge">Until dismissed</span>` : ""}
        ${r.active_window ? `<span class="badge">🕐 ${esc(r.active_window)}</span>` : ""}
        <span class="badge" style="color:${r.priority_color}">${r.priority_label}</span>
        <span class="badge tone-badge">${toneEmoji(r.tone)} ${toneName(r.tone)}</span>
      </div>
      <div class="card-next">
        Next: <strong>${fmtNextSchedule(r)}</strong>${r.all_day ? "" : relativeNext(r.next_fire)}
        ${r.snooze_until ? `<br>Snoozed until <strong>${fmtDate(r.snooze_until)}</strong>` : ""}
        ${needsUrgentAddress ? `<br><span class="card-hint urgent-hint">Mark ✓ addressed to stop repeat alerts</span>` : ""}
      </div>
      <div class="card-actions">
        ${renderUrgentAddressButton(r)}
        ${r.status !== "DISMISSED" && r.status !== "TRIGGERED" ? `
          <button class="btn-sm primary" onclick="openSnooze('${r.id}', event)">💤 Snooze</button>
          <button class="btn-sm" onclick="dismissReminder('${r.id}')">✓ Dismiss</button>
        ` : ""}
        ${r.status === "DISMISSED" || r.status === "TRIGGERED" ? `
          <button class="btn-sm primary" onclick="reactivateReminder('${r.id}')">↻ Reactivate</button>
        ` : ""}
        <button class="btn-sm" onclick="editReminder('${r.id}')">✎ Edit</button>
        <button class="btn-sm danger" onclick="deleteReminder('${r.id}')">🗑</button>
      </div>
    </article>
  `;
      }
    )
    .join("");

  initReminderDragDrop();
  grid.querySelectorAll("[data-urgent-address]").forEach((btn) => {
    btn.addEventListener("click", () => markReminderAddressed(btn.getAttribute("data-urgent-address")));
  });
  markListSettled();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function toneEmoji(id) {
  return (meta.tones && meta.tones.find(function(t) { return t.id === id; }) || {}).emoji || "🔔";
}

function toneName(id) {
  return (meta.tones && meta.tones.find(function(t) { return t.id === id; }) || {}).name || id;
}

function populateFormMeta() {
  $("#f-type").innerHTML = meta.types
    .map((t) => `<option value="${t.id}">${t.icon} ${t.label}</option>`)
    .join("");

  $("#f-priority").innerHTML = meta.priorities
    .map((p) => `<option value="${p.id}">${p.label}</option>`)
    .join("");

  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  $("#day-picker").innerHTML = days
    .map(
      (d, i) =>
        `<button type="button" class="day-btn" data-day="${i}">${d}</button>`
    )
    .join("");

  $$(".day-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const day = btn.dataset.day;
      if (selectedDays.has(day)) {
        selectedDays.delete(day);
        btn.classList.remove("selected");
      } else {
        selectedDays.add(day);
        btn.classList.add("selected");
      }
    });
  });

  $("#color-picker").innerHTML = meta.colors
    .map(
      (c) =>
        `<button type="button" class="color-swatch${c === selectedColor ? " selected" : ""}" style="background:${c}" data-color="${c}"></button>`
    )
    .join("");

  $$(".color-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      selectedColor = sw.dataset.color;
      $$(".color-swatch").forEach((s) => s.classList.remove("selected"));
      sw.classList.add("selected");
    });
  });

  renderToneGrid();
}

function renderToneGrid() {
  $("#tone-grid").innerHTML = (meta.tones || [])
    .map(
      (t) => `
    <div class="tone-option${t.id === selectedTone ? " selected" : ""}" data-tone="${t.id}">
      <span class="tone-emoji">${t.emoji}</span>
      <div>
        <div class="tone-name">${t.name}</div>
        <div class="tone-desc">${t.description}</div>
      </div>
      ${t.id !== "silent" ? `<button type="button" class="tone-preview-btn" data-preview="${t.id}">▶</button>` : ""}
    </div>
  `
    )
    .join("");

  $$(".tone-option").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".tone-preview-btn")) return;
      selectedTone = el.dataset.tone;
      $$(".tone-option").forEach((o) => o.classList.remove("selected"));
      el.classList.add("selected");
    });
  });

  $$(".tone-preview-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const tone = btn.dataset.preview;
      playWebAudioTone(tone);
      try {
        await api("/api/tones/preview", {
          method: "POST",
          body: JSON.stringify({ tone: tone }),
        });
      } catch {}
    });
  });
}

function fmtTimeShort(iso) {
  if (!iso) return "";
  const part = iso.includes("T") ? iso.split("T")[1] : iso.split(" ")[1];
  if (!part) return fmtTime12(iso);
  return fmtTime12FromClock(part.slice(0, 8));
}

function fmtNextSchedule(r) {
  if (r.type === "DAILY") {
    const t = r.all_day ? "all day" : fmtTimeShort(r.trigger_time);
    return `Every day at ${t}${r.active_window ? ` · ${r.active_window}` : ""}`;
  }
  if (r.type === "INTERVAL_MINUTES") {
    return `Every ${r.interval_minutes} min${r.active_window ? ` · ${r.active_window}` : ""}`;
  }
  if (r.type === "HOURLY") {
    return `Every hour${r.active_window ? ` · ${r.active_window}` : ""}`;
  }
  return fmtDate(r.next_fire, r.all_day);
}

function isRecurringType(type) {
  return type !== "ONE_TIME";
}

function usesTimeOnly(type) {
  return ["DAILY", "WEEKLY", "HOURLY"].includes(type);
}

function updateWindowFields() {
  const enabled = $("#f-use-window").checked;
  $("#window-times").classList.toggle("hidden", !enabled);
  $("#window-hint").classList.toggle("hidden", !enabled);
}

function updateTypeFields() {
  const type = $("#f-type").value;
  const isOneTime = type === "ONE_TIME";

  $("#interval-field").classList.toggle("hidden", type !== "INTERVAL_MINUTES");
  $("#days-field").classList.toggle("hidden", type !== "WEEKLY");
  $("#recurring-hint").classList.toggle("hidden", type !== "DAILY");
  $("#datetime-field").classList.toggle("hidden", type === "INTERVAL_MINUTES");
  $("#window-field").classList.toggle("hidden", false);

  $$(".schedule-input").forEach((el) => el.classList.add("hidden"));

  if (isOneTime) {
    updateDateTimeMode();
  } else if (usesTimeOnly(type)) {
    $("#f-time").classList.remove("hidden");
    $("#datetime-label").textContent =
      type === "DAILY" ? "Time each day" : type === "WEEKLY" ? "Time on selected days" : "Starting from";
    $("#all-day-wrap").classList.toggle("hidden", type === "HOURLY");
  }

  updateWindowFields();
}

function supportsAllDay(type) {
  return ["ONE_TIME", "WEEKLY"].includes(type);
}

function updateDateTimeMode() {
  const type = $("#f-type").value;
  if (type !== "ONE_TIME") return;

  const allDay = $("#f-all-day").checked;
  $("#all-day-wrap").classList.remove("hidden");
  $("#f-datetime").classList.toggle("hidden", allDay);
  $("#f-date").classList.toggle("hidden", !allDay);
  $("#datetime-label").textContent = allDay ? "Date" : "Date & Time";

  if (allDay && $("#f-datetime").value && !$("#f-date").value) {
    $("#f-date").value = $("#f-datetime").value.slice(0, 10);
  } else if (!allDay && $("#f-date").value && !$("#f-datetime").value) {
    $("#f-datetime").value = `${$("#f-date").value}T${String(ALL_DAY_HOUR).padStart(2, "0")}:00`;
  }
}

function buildTriggerTime(type) {
  const allDay = $("#f-all-day").checked && supportsAllDay(type);

  if (type === "ONE_TIME") {
    if (allDay) {
      const date = $("#f-date").value;
      if (!date) return null;
      return `${date} ${String(ALL_DAY_HOUR).padStart(2, "0")}:00:00`;
    }
    const dt = $("#f-datetime").value;
    if (!dt) return null;
    return `${dt.replace("T", " ")}:00`;
  }

  if (usesTimeOnly(type)) {
    if (allDay) {
      return `${String(ALL_DAY_HOUR).padStart(2, "0")}:00:00`;
    }
    const t = $("#f-time").value;
    if (!t) return null;
    return t.length === 5 ? `${t}:00` : t;
  }

  return null;
}

function openModal(edit = null) {
  $("#modal-overlay").classList.remove("hidden");
  $("#modal-title").textContent = edit ? "Edit Reminder" : "New Reminder";
  $("#edit-id").value = (edit && edit.id) ? edit.id : "";

  if (edit) {
    $("#f-title").value = edit.title;
    $("#f-description").value = edit.description;
    $("#f-type").value = edit.type;
    $("#f-priority").value = edit.priority;
    $("#f-interval").value = edit.interval_minutes || 10;
    selectedColor = edit.color;
    selectedTone = edit.tone;
    $("#f-all-day").checked = !!edit.all_day;
    const hasWindow = !!(edit.active_from && edit.active_until);
    $("#f-use-window").checked = hasWindow;
    if (edit.active_from) $("#f-active-from").value = edit.active_from.slice(0, 5);
    if (edit.active_until) $("#f-active-until").value = edit.active_until.slice(0, 5);
    if (edit.trigger_time) {
      const timePart = edit.trigger_time.slice(11, 16);
      $("#f-time").value = timePart;
      if (edit.all_day) {
        $("#f-date").value = edit.trigger_time.slice(0, 10);
        $("#f-datetime").value = `${edit.trigger_time.slice(0, 10)}T${String(ALL_DAY_HOUR).padStart(2, "0")}:00`;
      } else if (edit.type === "ONE_TIME") {
        $("#f-datetime").value = edit.trigger_time.slice(0, 16).replace(" ", "T");
        $("#f-date").value = edit.trigger_time.slice(0, 10);
      }
    }
    selectedDays = new Set(
      (edit.days_of_week || "").split(",").filter(Boolean)
    );
  } else {
    $("#reminder-form").reset();
    selectedColor = (meta.colors && meta.colors[0]) || "#6366f1";
    selectedTone = "chime";
    selectedDays = new Set();
    $("#f-type").value = "DAILY";
    $("#f-all-day").checked = false;
    $("#f-use-window").checked = false;
    $("#f-active-from").value = "08:00";
    $("#f-active-until").value = "18:00";
    $("#f-time").value = "09:00";
    const now = new Date();
    now.setMinutes(now.getMinutes() + 30 - (now.getMinutes() % 5));
    $("#f-datetime").value = now.toISOString().slice(0, 16);
    $("#f-date").value = now.toISOString().slice(0, 10);
  }

  $$(".day-btn").forEach((btn) => {
    btn.classList.toggle("selected", selectedDays.has(btn.dataset.day));
  });
  $$(".color-swatch").forEach((sw) => {
    sw.classList.toggle("selected", sw.dataset.color === selectedColor);
  });
  renderToneGrid();
  updateTypeFields();
  updateDateTimeMode();
  updateWindowFields();
}

function closeModal() {
  $("#modal-overlay").classList.add("hidden");
}

async function saveReminder(e) {
  e.preventDefault();
  const id = $("#edit-id").value;
  const type = $("#f-type").value;

  const dayNames = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const days = [...selectedDays].map((d) => dayNames[parseInt(d)]).join(",");
  const allDay = $("#f-all-day").checked && supportsAllDay(type);

  const payload = {
    title: $("#f-title").value.trim(),
    description: $("#f-description").value.trim(),
    type,
    priority: $("#f-priority").value,
    tone: selectedTone,
    color: selectedColor,
    all_day: allDay,
    use_active_window: $("#f-use-window").checked,
    active_from: $("#f-active-from").value ? `${$("#f-active-from").value}:00` : null,
    active_until: $("#f-active-until").value ? `${$("#f-active-until").value}:00` : null,
    trigger_time: buildTriggerTime(type),
    interval_minutes:
      type === "INTERVAL_MINUTES"
        ? parseInt($("#f-interval").value, 10)
        : null,
    days_of_week: type === "WEEKLY" ? days : null,
  };

  try {
    if (id) {
      await api(`/api/reminders/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      toast("Reminder updated");
    } else {
      await api("/api/reminders", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast("Reminder created");
    }
    closeModal();
    loadReminders();
  } catch (err) {
    toast(err.message, "error");
  }
}

window.editReminder = function (id) {
  const r = reminders.find((x) => x.id === id || x.id.startsWith(id));
  if (r) {
    openModal(r);
    return;
  }
  api(`/api/reminders/${id}`).then((data) => {
    if (data.reminder) openModal(data.reminder);
  }).catch(() => toast("Reminder not found", "error"));
};

window.deleteReminder = async function (id) {
  if (!confirm("Delete this reminder permanently?")) return;
  try {
    await api(`/api/reminders/${id}`, { method: "DELETE" });
    toast("Reminder deleted");
    loadReminders();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.dismissReminder = async function (id) {
  try {
    await api(`/api/reminders/${id}/dismiss`, { method: "POST", body: "{}" });
    toast("Reminder dismissed");
    loadReminders();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.reactivateReminder = async function (id) {
  try {
    await api(`/api/reminders/${id}/reactivate`, { method: "POST", body: "{}" });
    toast("Reminder reactivated");
    loadReminders();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.openSnooze = function (id, event) {
  snoozeTargetId = id;
  const pop = $("#snooze-popover");
  pop.classList.remove("hidden");
  const rect = event.target.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.left = `${rect.left}px`;
};

async function snoozeReminder(minutes) {
  if (!snoozeTargetId) return;
  try {
    await api(`/api/reminders/${snoozeTargetId}/snooze`, {
      method: "POST",
      body: JSON.stringify({ minutes }),
    });
    toast(`Snoozed for ${minutes} minutes`);
    $("#snooze-popover").classList.add("hidden");
    snoozeTargetId = null;
    loadReminders();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ── Theme ── */

function getTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("remindme-theme", theme);
  $("#btn-theme").textContent = theme === "dark" ? "🌙" : "☀️";
  $("#btn-theme").title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

function toggleTheme() {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

/* ── View switching ── */

function switchView(view) {
  currentView = view;
  lastCalendarFingerprint = "";
  if (view === "list" || view === "calendar") {
    lastRemindersFingerprint = "";
  }
  $$(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#list-view").classList.toggle("hidden", view !== "list");
  $("#calendar-view").classList.toggle("hidden", view !== "calendar");
  $("#guide-view").classList.toggle("hidden", view !== "guide");
  $("#search-box").classList.toggle("hidden", view !== "list");

  const titles = {
    list: pageTitleForFilter(currentFilter),
    calendar: "Calendar",
    guide: "Google Setup Guide",
  };
  const subtitles = {
    list: pageSubtitleForFilter(currentFilter),
    calendar: currentFilter === "GOOGLE"
      ? "Google Calendar and Tasks"
      : "Upcoming reminders at a glance",
    guide: "Connect Google Calendar & Tasks with OAuth",
  };
  if (currentFilter === "GOOGLE" && view === "list") {
    titles.list = "Google Calendar & Tasks";
    subtitles.list = "Synced Google Calendar events and Tasks";
  } else if (currentFilter !== "all" && view === "list") {
    titles.list = pageTitleForFilter(currentFilter);
    subtitles.list = pageSubtitleForFilter(currentFilter);
  }
  if (currentFilter === "GOOGLE" && view === "calendar") {
    subtitles.calendar = "Google Calendar and Tasks";
  }
  $("#page-title").textContent = titles[view] || titles.list;
  $("#page-subtitle").textContent = subtitles[view] || "";
  updateGoogleToneBarVisibility();

  if (view === "calendar") {
    loadCalendar();
  } else if (view === "guide") {
    loadOAuthSetupGuide();
    updateGuideSigninButton();
  } else if (currentFilter === "GOOGLE") {
    renderGoogleItems();
  } else {
    renderReminders();
  }
}

function openSetupGuide() {
  switchView("guide");
  $$(".view-btn").forEach((b) => b.classList.remove("active"));
}

function closeSetupGuide() {
  switchView("list");
}

function updateGuideSigninButton() {
  const btn = $("#btn-guide-signin");
  if (!btn) return;
  const ready = googleStatus.signin_ready && !googleStatus.connected;
  btn.classList.toggle("hidden", !ready);
  btn.disabled = (googleStatus.signin_state && googleStatus.signin_state.status === "connecting");
}

/* ── Calendar ── */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function loadCalendar(opts = {}) {
  const silent = opts.silent === true;
  let statusParam = "";
  if (currentFilter === "GOOGLE") {
    statusParam = "&source=google";
  } else if (currentFilter !== "all") {
    statusParam = `&status=${currentFilter}`;
  }
  const next = await api(`/api/calendar?year=${calYear}&month=${calMonth}${statusParam}`);
  const fingerprint = dataFingerprint({
    year: calYear,
    month: calMonth,
    filter: currentFilter,
    data: next,
  });
  calendarData = next;
  if (silent && fingerprint === lastCalendarFingerprint) return;
  lastCalendarFingerprint = fingerprint;
  renderCalendar();
}

function renderCalendar() {
  $("#cal-month-label").textContent = `${MONTH_NAMES[calMonth - 1]} ${calYear}`;

  const firstDay = new Date(calYear, calMonth - 1, 1);
  const lastDay = new Date(calYear, calMonth, 0);
  const startPad = (firstDay.getDay() + 6) % 7; // Mon=0
  const daysInMonth = lastDay.getDate();

  const prevMonth = calMonth === 1 ? 12 : calMonth - 1;
  const prevYear = calMonth === 1 ? calYear - 1 : calYear;
  const prevLast = new Date(prevYear, prevMonth, 0).getDate();

  const today = new Date();
  const todayKey = fmtDayKey(today);

  let html = '<div class="cal-weekdays">';
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d) => {
    html += `<div class="cal-weekday">${d}</div>`;
  });
  html += '</div><div class="cal-days">';

  for (let i = startPad - 1; i >= 0; i--) {
    const day = prevLast - i;
    html += calDayCell(prevYear, prevMonth, day, true, todayKey);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    html += calDayCell(calYear, calMonth, day, false, todayKey);
  }

  const totalCells = startPad + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  const nextMonth = calMonth === 12 ? 1 : calMonth + 1;
  const nextYear = calMonth === 12 ? calYear + 1 : calYear;
  for (let day = 1; day <= remaining; day++) {
    html += calDayCell(nextYear, nextMonth, day, true, todayKey);
  }

  html += "</div>";
  $("#calendar-grid").innerHTML = html;

  $$(".cal-day").forEach((cell) => {
    cell.addEventListener("click", () => selectCalDay(cell.dataset.date));
  });

  if (calSelectedDay && calendarData.days[calSelectedDay]) {
    selectCalDay(calSelectedDay);
  } else if (calSelectedDay) {
    selectCalDay(calSelectedDay);
  }
}

function fmtDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function calDayCell(year, month, day, otherMonth, todayKey) {
  const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const events = calendarData.days[dateKey] || [];
  const isToday = dateKey === todayKey;
  const isSelected = dateKey === calSelectedDay;

  const dots = events.slice(0, 4).map(
    (e) => `<span class="cal-dot" style="background:${e.color}" title="${esc(e.title)}"></span>`
  ).join("");
  const more = events.length > 4 ? `<span class="cal-more">+${events.length - 4}</span>` : "";

  return `
    <div class="cal-day${otherMonth ? " other-month" : ""}${isToday ? " today" : ""}${isSelected ? " selected" : ""}"
         data-date="${dateKey}">
      <span class="cal-day-num">${day}</span>
      <div class="cal-day-dots">${dots}${more}</div>
    </div>`;
}

function selectCalDay(dateKey) {
  calSelectedDay = dateKey;
  $$(".cal-day").forEach((c) => c.classList.toggle("selected", c.dataset.date === dateKey));

  const [y, m, d] = dateKey.split("-").map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  $("#cal-day-label").textContent = label;

  const events = calendarData.days[dateKey] || [];
  const container = $("#cal-day-events");

  if (events.length === 0) {
    container.innerHTML = '<p class="cal-empty">No reminders scheduled</p>';
    return;
  }

  container.innerHTML = events.map((e, idx) => {
    const badge = e.is_google
      ? `<span class="badge ${e.type === "google_calendar" ? "google-badge" : "google-tasks-badge"}">${e.source_label || "Google"}</span>`
      : "";
    const attrs = e.is_google
      ? `class="cal-event google-event" data-google-idx="${idx}"`
      : `class="cal-event" onclick="editReminder('${e.reminder_id}')"`;
    return `
    <div ${attrs} style="--event-color:${e.color}">
      <span class="cal-event-time">${e.all_day ? "All day" : fmtTime12FromClock(e.time)}</span>
      <span class="cal-event-title">${esc(e.title)}</span>
      ${badge}
    </div>`;
  }).join("");

  container.querySelectorAll("[data-google-idx]").forEach((el) => {
    el.addEventListener("click", () => {
      const ev = events[parseInt(el.dataset.googleIdx, 10)];
      if (ev && ev.html_link) window.open(ev.html_link, "_blank", "noopener");
    });
  });
}

function calPrevMonth() {
  if (calMonth === 1) { calMonth = 12; calYear--; }
  else calMonth--;
  calSelectedDay = null;
  loadCalendar();
}

function calNextMonth() {
  if (calMonth === 12) { calMonth = 1; calYear++; }
  else calMonth++;
  calSelectedDay = null;
  loadCalendar();
}

function calGoToday() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;
  calSelectedDay = fmtDayKey(now);
  loadCalendar();
}

function setupEvents() {
  $("#btn-new").addEventListener("click", () => openModal());
  $("#btn-empty-new").addEventListener("click", () => openModal());
  $("#modal-close").addEventListener("click", closeModal);
  $("#btn-cancel").addEventListener("click", closeModal);
  $("#modal-overlay").addEventListener("click", (e) => {
    if (e.target === $("#modal-overlay")) closeModal();
  });

  const btnSchedCall = $("#btn-schedule-call");
  if (btnSchedCall) btnSchedCall.addEventListener("click", openScheduleCallModal);
  const callClose = $("#call-modal-close");
  if (callClose) callClose.addEventListener("click", closeScheduleCallModal);
  const callCancel = $("#btn-call-cancel");
  if (callCancel) callCancel.addEventListener("click", closeScheduleCallModal);
  const callForm = $("#schedule-call-form");
  if (callForm) callForm.addEventListener("submit", scheduleGoogleCall);
  const callOverlay = $("#schedule-call-overlay");
  if (callOverlay) {
    callOverlay.addEventListener("click", (e) => {
      if (e.target === callOverlay) closeScheduleCallModal();
    });
  }
  $("#google-detail-close").addEventListener("click", closeGoogleDetail);
  $("#google-detail-close-btn").addEventListener("click", closeGoogleDetail);
  $("#google-detail-overlay").addEventListener("click", (e) => {
    if (e.target === $("#google-detail-overlay")) closeGoogleDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#google-detail-overlay").classList.contains("hidden")) {
      closeGoogleDetail();
      return;
    }
    if (currentView === "guide") {
      closeSetupGuide();
    }
  });
  $("#reminder-form").addEventListener("submit", saveReminder);
  $("#f-type").addEventListener("change", updateTypeFields);
  $("#f-all-day").addEventListener("change", updateDateTimeMode);
  $("#f-use-window").addEventListener("change", updateWindowFields);
  $("#btn-refresh").addEventListener("click", loadReminders);
  $("#btn-theme").addEventListener("click", toggleTheme);

  $("#search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    if (currentFilter === "GOOGLE") renderGoogleItems();
    else renderReminders();
    $("#page-subtitle").textContent = pageSubtitleForFilter(currentFilter);
  });

  $$(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  $("#cal-prev").addEventListener("click", calPrevMonth);
  $("#cal-next").addEventListener("click", calNextMonth);
  $("#cal-today").addEventListener("click", calGoToday);

  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectNavFilter(btn.dataset.filter));
  });

  $$("#snooze-popover button").forEach((btn) => {
    btn.addEventListener("click", () =>
      snoozeReminder(parseInt(btn.dataset.min, 10))
    );
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#snooze-popover") && !e.target.closest(".btn-sm.primary")) {
      $("#snooze-popover").classList.add("hidden");
    }
  });

  const bgs1 = $("#btn-google-signin"); if (bgs1) bgs1.addEventListener("click", signInWithGoogle);
  const bgs = $("#btn-guide-signin"); if (bgs) bgs.addEventListener("click", signInWithGoogle);
  const sideLogin = $("#btn-sidebar-google-login"); if (sideLogin) sideLogin.addEventListener("click", signInWithGoogle);
  const bsg = $("#btn-show-guide"); if (bsg) bsg.addEventListener("click", openSetupGuide);
  const bgc = $("#btn-guide-close"); if (bgc) bgc.addEventListener("click", closeSetupGuide);
  const bgsync = $("#btn-google-sync"); if (bgsync) bgsync.addEventListener("click", syncGoogle);
  const bgdisc = $("#btn-google-disconnect"); if (bgdisc) bgdisc.addEventListener("click", disconnectGoogle);
  const bos = $("#btn-oauth-save"); if (bos) bos.addEventListener("click", saveOAuthCredentials);
  const bis = $("#btn-ical-save"); if (bis) bis.addEventListener("click", saveCalendarFeed);
  const iurl = $("#ical-url"); if (iurl) iurl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCalendarFeed();
  });

  const getSelect = $("#google-event-tone"); if (getSelect) getSelect.addEventListener("change", updateGoogleToneSaveState);
  const bgts = $("#btn-google-tone-save"); if (bgts) bgts.addEventListener("click", saveGoogleEventTone);
  const bgtp = $("#btn-google-tone-preview"); if (bgtp) bgtp.addEventListener("click", previewGoogleEventTone);

  const bcp = $("#btn-copy-redirect-uri");
  if (bcp) {
    bcp.addEventListener("click", () => {
      const uri = ($("#oauth-redirect-uri").textContent || "").trim();
      if (uri) {
        navigator.clipboard.writeText(uri).then(() => {
          toast("Redirect URI copied to clipboard!");
        }).catch(() => {
          toast("Failed to copy URI", "error");
        });
      }
    });
  }

  const bca = $("#btn-copy-all-uris");
  if (bca) {
    bca.addEventListener("click", () => {
      const listEl = $("#recommended-uris-list");
      if (listEl) {
        const text = Array.from(listEl.querySelectorAll("code")).map((c) => c.textContent.trim()).join("\n");
        navigator.clipboard.writeText(text).then(() => {
          toast("All redirect URIs copied!");
        }).catch(() => {
          toast("Failed to copy URIs", "error");
        });
      }
    });
  }
}

async function loadOAuthSetupGuide() {
  try {
    oauthSetupGuide = await api("/api/google/setup-guide");
    const uriEl = $("#oauth-redirect-uri");
    if (uriEl && oauthSetupGuide.redirect_uri) {
      uriEl.textContent = oauthSetupGuide.redirect_uri;
    }
    const listEl = $("#recommended-uris-list");
    if (listEl && oauthSetupGuide.recommended_uris && oauthSetupGuide.recommended_uris.length > 0) {
      listEl.innerHTML = oauthSetupGuide.recommended_uris.map((u) => `
        <code style="background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px;">${esc(u)}</code>
      `).join("");
    }
    const stepsEl = $("#oauth-steps");
    if (stepsEl && oauthSetupGuide.steps) {
      stepsEl.innerHTML = oauthSetupGuide.steps.map((s, i) => {
        const link = s.url
          ? `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.title)} ↗</a>`
          : `<strong>${esc(s.title)}</strong>`;
        const detailText = s.detail || s.desc || "";
        return `<li><span class="step-num">${i + 1}</span> ${link}${detailText ? `<p class="step-detail">${esc(detailText)}</p>` : ""}</li>`;
      }).join("");
    }
    const fallbackEl = $("#oauth-fallback");
    if (fallbackEl && oauthSetupGuide.fallback_navigation) {
      fallbackEl.textContent = oauthSetupGuide.fallback_navigation;
      fallbackEl.classList.remove("hidden");
    }
  } catch {
    oauthSetupGuide = null;
  }
}

async function toggleGoogleSilent(eventId) {
  if (!eventId) return;
  const item = googleItemsById[eventId] || reminders.find((r) => r.id === eventId);
  const enableSilent = !((item && item.silent != null ? item.silent : false));
  try {
    const result = await api("/api/google/events/silent", {
      method: "POST",
      body: JSON.stringify({ id: eventId, silent: enableSilent }),
    });
    if (item) item.silent = result.silent;
    googleItemsById[eventId] = { ...item, silent: result.silent };
    toast(result.silent ? "Event silenced — no reminders" : "Reminders enabled");
    if (currentFilter === "GOOGLE") renderGoogleItems();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function markGoogleAddressed(eventId) {
  if (!eventId) return;
  const item = googleItemsById[eventId] || reminders.find((r) => r.id === eventId);
  try {
    const result = await api("/api/google/events/addressed", {
      method: "POST",
      body: JSON.stringify({ id: eventId }),
    });
    const updated = {
      ...item,
      addressed: true,
      addressed_at: result.addressed_at,
      started: true,
    };
    googleItemsById[eventId] = updated;
    const idx = reminders.findIndex((r) => r.id === eventId);
    if (idx >= 0) reminders[idx] = updated;
    toast("Marked as addressed — reminders stopped");
    if (currentFilter === "GOOGLE") renderGoogleItems();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function markReminderAddressed(reminderId) {
  if (!reminderId) return;
  try {
    await api(`/api/reminders/${reminderId}/addressed`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    toast("Marked as addressed — repeat alerts stopped");
    await loadReminders();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function saveOAuthCredentials() {
  const client_id = $("#oauth-client-id").value.trim();
  const client_secret = $("#oauth-client-secret").value.trim();
  if (!client_id || !client_secret) {
    toast("Enter Client ID and Client Secret from Google Cloud", "error");
    return;
  }
  try {
    $("#btn-oauth-save").disabled = true;
    await api("/api/google/credentials", {
      method: "POST",
      body: JSON.stringify({ client_id, client_secret }),
    });
    toast("Credentials saved — click Sign in with Google");
    $("#oauth-client-secret").value = "";
    await loadGoogleStatus();
    updateGuideSigninButton();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#btn-oauth-save").disabled = false;
  }
}

async function loadGoogleStatus(opts = {}) {
  const silent = opts.silent === true;
  try {
    const next = await api("/api/google/status");
    const fingerprint = dataFingerprint(next);
    googleStatus = next;
    syncGoogleToneFromStatus();
    if (!(silent && fingerprint === lastGoogleStatusFingerprint)) {
      lastGoogleStatusFingerprint = fingerprint;
      renderGooglePanel();
    }
    if ((googleStatus.signin_state && googleStatus.signin_state.status === "connecting")) {
      pollGoogleSignin();
    }
  } catch {
    googleStatus = { connected: false, libraries_available: false };
    if (!silent || lastGoogleStatusFingerprint !== dataFingerprint(googleStatus)) {
      lastGoogleStatusFingerprint = dataFingerprint(googleStatus);
      renderGooglePanel();
    }
  }
}

function renderGooglePanel() {
  const statusEl = $("#google-status-text");
  if (!statusEl) return;
  const signinBtn = $("#btn-google-signin");
  const syncBtn = $("#btn-google-sync");
  const disconnectBtn = $("#btn-google-disconnect");
  const guideBtn = $("#btn-show-guide");
  const feedList = $("#feed-list");

  signinBtn.classList.add("hidden");
  syncBtn.classList.add("hidden");
  disconnectBtn.classList.add("hidden");
  guideBtn.classList.remove("hidden");
  signinBtn.disabled = false;
  signinBtn.classList.remove("connecting");
  signinBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Sign in with Google`;

  if (!googleStatus.libraries_available) {
    statusEl.textContent = "Install Google libraries — see Setup guide";
    return;
  }

  const feeds = googleStatus.calendar_feeds || [];
  const offsets = (googleStatus.reminder_settings && googleStatus.reminder_settings.offsets_minutes) || [10, 5, 0];

  if (googleStatus.connected) {
    const email = googleStatus.account_email ? ` · ${googleStatus.account_email}` : "";
    const synced = googleStatus.last_sync_at
      ? `Last sync ${fmtDate(googleStatus.last_sync_at)}`
      : "Synced";
    statusEl.textContent = `${synced}${email} · ${googleStatus.events_count || 0} items · ${formatReminderOffsets(offsets)}`;
    syncBtn.classList.remove("hidden");
    disconnectBtn.classList.remove("hidden");
    if (googleStatus.last_error) {
      statusEl.textContent += ` · Error: ${googleStatus.last_error}`;
    }
  } else if (!googleStatus.signin_ready) {
    statusEl.textContent = "Open Setup guide to connect";
  } else {
    statusEl.textContent = "Ready — open Setup guide to sign in";
    signinBtn.classList.remove("hidden");
  }

  if (feeds.length > 0) {
    feedList.classList.remove("hidden");
    feedList.innerHTML = feeds.map((f) => `
      <li>
        <span>${esc(f.label)} · ${f.last_sync_at ? fmtDate(f.last_sync_at) : "pending"}</span>
        <button type="button" class="btn-sm danger" data-remove-feed="${f.id}">✕</button>
      </li>`).join("");
    feedList.querySelectorAll("[data-remove-feed]").forEach((btn) => {
      btn.addEventListener("click", () => removeCalendarFeed(btn.dataset.removeFeed));
    });
  } else {
    feedList.classList.add("hidden");
  }

  const signinState = (googleStatus.signin_state && googleStatus.signin_state.status);
  if (signinState === "connecting") {
    signinBtn.classList.remove("hidden");
    signinBtn.disabled = true;
    signinBtn.textContent = "Signing in…";
    statusEl.textContent = "Complete sign-in in your browser…";
  }

  updateGuideSigninButton();
}

async function saveCalendarFeed() {
  const url = $("#ical-url").value.trim();
  if (!url) {
    toast("Paste your Google Calendar secret link first", "error");
    return;
  }
  try {
    $("#btn-ical-save").disabled = true;
    const result = await api("/api/calendar-feeds", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    toast(`Synced ${(result.sync && result.sync.events) || 0} calendar events`);
    $("#ical-url").value = "";
    await loadGoogleStatus();
    loadReminders();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#btn-ical-save").disabled = false;
  }
}

async function removeCalendarFeed(id) {
  if (!confirm("Remove this calendar link?")) return;
  try {
    await api(`/api/calendar-feeds/${id}`, { method: "DELETE" });
    toast("Calendar link removed");
    loadGoogleStatus();
    loadReminders();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function signInWithGoogle() {
  try {
    const data = await api("/api/google/signin", { method: "POST", body: "{}" });
    if (data.status === "connected") {
      toast("Already connected to Google");
      loadGoogleStatus();
      return;
    }
    if (data.status === "redirect" && data.auth_url) {
      window.location.href = data.auth_url;
      return;
    }
    if (data.status === "connecting") {
      toast("Complete sign-in in your browser");
      await loadGoogleStatus();
      pollGoogleSignin();
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

function pollGoogleSignin() {
  if (googleSigninPoll) clearInterval(googleSigninPoll);
  googleSigninPoll = setInterval(async () => {
    try {
      const state = await api("/api/google/signin/status");
      googleStatus.signin_state = state;
      if (state.status === "redirect" && state.auth_url) {
        clearInterval(googleSigninPoll);
        googleSigninPoll = null;
        window.location.href = state.auth_url;
        return;
      }
      const full = await api("/api/google/status");
      const fingerprint = dataFingerprint(full);
      googleStatus = full;
      if (fingerprint !== lastGoogleStatusFingerprint) {
        lastGoogleStatusFingerprint = fingerprint;
        renderGooglePanel();
      }
      if (full.connected) {
        clearInterval(googleSigninPoll);
        googleSigninPoll = null;
        toast(`Connected${full.account_email ? ` as ${full.account_email}` : ""}`);
        loadReminders();
        return;
      }
      if (state.status === "error") {
        clearInterval(googleSigninPoll);
        googleSigninPoll = null;
        toast(state.message || "Google sign-in failed", "error");
      }
    } catch {
      /* keep polling */
    }
  }, 2000);
}

async function uploadGoogleCredentials(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast("Invalid JSON file", "error");
    return;
  }
  try {
    await api("/api/google/credentials", {
      method: "POST",
      body: JSON.stringify({ credentials: parsed }),
    });
    toast("OAuth credentials saved");
    await loadGoogleStatus();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function connectGoogle() {
  return signInWithGoogle();
}

async function syncGoogle() {
  try {
    syncBtnBusy(true);
    const result = await api("/api/google/sync", { method: "POST", body: "{}" });
    toast(`Synced ${result.calendar_events || 0} events, ${result.tasks || 0} tasks`);
    await loadGoogleStatus();
    if (currentFilter === "GOOGLE" || currentView === "calendar") {
      loadReminders();
    }
  } catch (err) {
    toast(err.message, "error");
    loadGoogleStatus();
  } finally {
    syncBtnBusy(false);
  }
}

function syncBtnBusy(busy) {
  const btn = $("#btn-google-sync");
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? "Syncing…" : "↻ Sync";
}

async function disconnectGoogle() {
  if (!confirm("Disconnect Google and clear synced events from this device?")) return;
  try {
    await api("/api/google/disconnect", { method: "POST", body: "{}" });
    toast("Google disconnected");
    await loadGoogleStatus();
    if (currentFilter === "GOOGLE") loadReminders();
  } catch (err) {
    toast(err.message, "error");
  }
}

function handleGoogleQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("google");
  if (state === "connected") {
    toast("Google account connected");
    loadGoogleStatus();
    loadReminders();
  } else if (state === "error") {
    const rawMsg = params.get("message") || "unknown error";
    const msg = decodeURIComponent(rawMsg);
    toast(`Google connect error: ${msg}`, "error");
    if (msg.indexOf("redirect_uri_mismatch") !== -1 || msg.indexOf("credentials") !== -1 || msg.indexOf("OAuth") !== -1) {
      setTimeout(openSetupGuide, 400);
    }
    loadGoogleStatus();
  }
  if (state) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

// ==========================================
// Web Notifications & In-App Alerts System
// ==========================================

let soundEnabled = true;

function initAudioStatus() {
  const btn = document.getElementById("btn-audio-status");
  const text = document.getElementById("audio-text");
  if (!btn) return;
  btn.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    btn.classList.toggle("active", soundEnabled);
    if (text) text.textContent = soundEnabled ? "Audio On" : "Muted";
    toast(soundEnabled ? "Notification sound enabled" : "Notification sound muted");
  });
}

function initNotificationControls() {
  const notifBtn = document.getElementById("btn-notifications");
  const notifText = document.getElementById("notif-text");
  if (!notifBtn || !("Notification" in window)) return;

  function updateStatus() {
    if (Notification.permission === "granted") {
      notifBtn.classList.add("active");
      if (notifText) notifText.textContent = "Alerts On";
    } else if (Notification.permission === "denied") {
      notifBtn.classList.remove("active");
      if (notifText) notifText.textContent = "Blocked";
    } else {
      notifBtn.classList.remove("active");
      if (notifText) notifText.textContent = "Enable Alerts";
    }
  }

  notifBtn.addEventListener("click", async () => {
    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      updateStatus();
      if (perm === "granted") {
        toast("Browser notifications enabled!");
      }
    } else if (Notification.permission === "granted") {
      toast("Desktop notifications are active");
    } else {
      toast("Notifications are blocked in your browser settings", "error");
    }
  });

  updateStatus();
}

function showBrowserNotification(title, body, tag) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, {
        body: body || "RemindMe alert",
        icon: "/icon.svg",
        tag: tag || "remindme-" + Date.now(),
        renotify: true
      });
    } catch (e) {}
  }
}

function showInAppAlert(data) {
  const container = document.getElementById("notification-alerts-container");
  if (!container) return;

  const card = document.createElement("div");
  const isUrgent = data.priority === "urgent" || data.isUrgent;
  card.className = `reminder-alert-card ${isUrgent ? "urgent" : ""}`;
  card.style.setProperty("--alert-color", data.color || (isUrgent ? "#f87171" : "#6366f1"));

  const toneObj = (meta.tones || []).find((t) => t.id === data.tone) || { emoji: "⏰" };
  const title = data.title || (data.event && data.event.title) || "Reminder";
  const desc = data.description || (data.event && data.event.description) || (data.offset_label ? `${data.source_name || "Google"}: ${data.offset_label}` : "");

  card.innerHTML = `
    <div class="alert-header">
      <div class="alert-title-wrap">
        <span class="alert-tone-emoji">${toneObj.emoji || "⏰"}</span>
        <h4 class="alert-title">${esc(title)}</h4>
      </div>
      <button class="alert-close" title="Close" aria-label="Close notification">✕</button>
    </div>
    ${desc ? `<p class="alert-body">${esc(desc)}</p>` : ""}
    <div class="alert-actions">
      <button class="btn-alert-dismiss" type="button">Dismiss</button>
      <button class="btn-alert-snooze" type="button" data-min="5">Snooze 5m</button>
      <button class="btn-alert-snooze" type="button" data-min="10">10m</button>
      <button class="btn-alert-snooze" type="button" data-min="30">30m</button>
      ${isUrgent && (data.urgent_occurrence_key || data.occurrence_key) ? `<button class="btn-alert-addressed" type="button">✓ Mark Addressed</button>` : ""}
    </div>
  `;

  card.querySelector(".alert-close").addEventListener("click", () => card.remove());

  const dismissBtn = card.querySelector(".btn-alert-dismiss");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", async () => {
      try {
        if (data.id) {
          await api(`/api/reminders/${data.id}/dismiss`, { method: "POST" });
        }
        card.remove();
        toast("Reminder dismissed");
        loadReminders({ silent: true });
        loadStats();
      } catch (e) {
        toast(e.message, "error");
      }
    });
  }

  card.querySelectorAll(".btn-alert-snooze").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mins = parseInt(btn.dataset.min, 10);
      try {
        if (data.id) {
          if (data.source && (data.source === "google_calendar" || data.source === "google_tasks")) {
            await api("/api/google/events/snooze", {
              method: "POST",
              body: JSON.stringify({ id: data.id, minutes: mins }),
            });
          } else {
            await api(`/api/reminders/${data.id}/snooze`, {
              method: "POST",
              body: JSON.stringify({ minutes: mins }),
            });
          }
        }
        card.remove();
        toast(`Snoozed for ${mins} minutes`);
        loadReminders({ silent: true });
        loadStats();
      } catch (e) {
        toast(e.message, "error");
      }
    });
  });

  const addressedBtn = card.querySelector(".btn-alert-addressed");
  if (addressedBtn) {
    addressedBtn.addEventListener("click", async () => {
      try {
        await api(`/api/reminders/${data.id}/addressed`, { method: "POST" });
        card.remove();
        toast("Marked addressed ✓");
        loadReminders({ silent: true });
      } catch (e) {
        toast(e.message, "error");
      }
    });
  }

  container.appendChild(card);

  // Auto remove after 35 seconds if not urgent
  if (!isUrgent) {
    setTimeout(() => {
      if (card.parentNode) card.remove();
    }, 35000);
  }
}

// ==========================================
// User Google Profile & Login Widget
// ==========================================

async function loadUserProfile() {
  const widget = document.getElementById("user-widget");
  const gdriveBtn = document.getElementById("btn-gdrive-sync");
  const gdriveText = document.getElementById("gdrive-text");
  const sidebarLoginBtn = document.getElementById("btn-sidebar-google-login");
  if (!widget) return;

  try {
    const data = await api("/api/auth/me");
    if (data.authenticated && data.user) {
      const u = data.user;
      const initial = (u.name || u.email || "U")[0].toUpperCase();
      if (sidebarLoginBtn) sidebarLoginBtn.classList.add("hidden");
      widget.innerHTML = `
        <div class="user-pill" title="${esc(u.email)}">
          ${u.picture ? `<img class="user-avatar" src="${esc(u.picture)}" alt="avatar" />` : `<div class="user-avatar">${initial}</div>`}
          <span class="user-name">${esc(u.name || u.email.split("@")[0])}</span>
          <button class="btn-signout" id="btn-user-logout" title="Sign out">Log out</button>
        </div>
      `;

      if (sidebarLoginBtn) sidebarLoginBtn.classList.add("hidden");

      if (gdriveBtn) {
        gdriveBtn.classList.remove("hidden");
        gdriveBtn.onclick = async () => {
          try {
            if (gdriveText) gdriveText.textContent = "Syncing…";
            gdriveBtn.disabled = true;
            const res = await api("/api/gdrive/sync", { method: "POST" });
            toast(`Synced ${res.reminders_count || 0} items with Google Drive ✓`);
            if (gdriveText) gdriveText.textContent = "Drive Synced";
            loadReminders({ silent: true });
          } catch (e) {
            toast(e.message || "Drive sync failed", "error");
            if (gdriveText) gdriveText.textContent = "Drive Error";
          } finally {
            gdriveBtn.disabled = false;
          }
        };
      }

      var bul = document.getElementById("btn-user-logout");
      if (bul) {
        bul.addEventListener("click", async () => {
          await api("/api/auth/logout", { method: "POST" });
          toast("Signed out");
          loadUserProfile();
          loadGoogleStatus();
        });
      }
    } else {
      if (gdriveBtn) gdriveBtn.classList.add("hidden");
      if (sidebarLoginBtn) {
        sidebarLoginBtn.classList.remove("hidden");
        sidebarLoginBtn.disabled = false;
      }
      widget.innerHTML = `
        <a class="btn-signin-google-topbar" href="${BASE_PATH}/auth/google" id="btn-topbar-signin" title="Sign in with Google">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          <span>Sign in with Google</span>
        </a>
      `;
    }
  } catch (e) {
    const sidebarLoginBtn = document.getElementById("btn-sidebar-google-login");
    if (sidebarLoginBtn) {
      sidebarLoginBtn.classList.remove("hidden");
      sidebarLoginBtn.disabled = false;
    }
    widget.innerHTML = "";
    if (gdriveBtn) gdriveBtn.classList.add("hidden");
  }
}

// ==========================================
// Server-Sent Events (SSE) Live Stream
// ==========================================

function initSSE() {
  if (!("EventSource" in window)) return;
  const eventSource = new EventSource("/api/events/stream");

  eventSource.addEventListener("REMINDER_FIRED", (e) => {
    try {
      const data = JSON.parse(e.data);
      const reminder = data.reminder;
      if (soundEnabled) {
        playWebAudioTone(reminder.tone || "chime");
      }
      showBrowserNotification("⏰ " + reminder.title, reminder.description, reminder.id);
      showInAppAlert(reminder);
      loadReminders({ silent: true });
      loadStats();
    } catch (err) {
      console.error("SSE reminder error:", err);
    }
  });

  eventSource.addEventListener("EXTERNAL_REMINDER_FIRED", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (soundEnabled) {
        playWebAudioTone(data.tone || "chime");
      }
      showBrowserNotification("📅 " + data.event.title, `${data.source_name || "Google"}: ${data.offset_label}`, data.event.id);
      showInAppAlert({
        id: data.event.id,
        title: data.event.title,
        description: data.event.description,
        tone: data.tone,
        offset_label: data.offset_label,
        source_name: data.source_name,
        color: "#4285f4",
      });
      loadReminders({ silent: true });
    } catch (err) {
      console.error("SSE external reminder error:", err);
    }
  });

  eventSource.addEventListener("URGENT_NUDGE_FIRED", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (soundEnabled) {
        playWebAudioTone(data.tone || "urgent");
      }
      showBrowserNotification("⚡ Urgent Nudge: " + data.reminder.title, "Needs immediate attention", data.reminder.id);
      showInAppAlert({
        id: data.reminder.id,
        title: data.reminder.title,
        description: data.reminder.description || "Needs your immediate attention!",
        priority: "urgent",
        isUrgent: true,
        urgent_occurrence_key: data.occurrence_key,
        color: "#f87171",
      });
    } catch (err) {
      console.error("SSE urgent nudge error:", err);
    }
  });

  eventSource.addEventListener("UNADDRESSED_NUDGE_FIRED", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (soundEnabled) {
        playWebAudioTone(data.tone || "urgent");
      }
      showInAppAlert({
        id: data.event.id,
        title: data.event.title,
        description: "Event is active — mark as addressed when done",
        priority: "urgent",
        isUrgent: true,
        color: "#fbbf24",
      });
    } catch (err) {
      console.error("SSE unaddressed nudge error:", err);
    }
  });

  eventSource.addEventListener("GOOGLE_EVENTS_UPDATED", () => {
    try {
      loadReminders({ silent: true });
      loadGoogleStatus({ silent: true });
    } catch (err) {}
  });

  eventSource.addEventListener("GOOGLE_ITEMS_CHANGED", () => {
    try {
      loadReminders({ silent: true });
    } catch (err) {}
  });
}

function openScheduleCallModal() {
  const modal = $("#schedule-call-overlay");
  if (!modal) return;
  const dateInput = $("#call-date");
  if (dateInput && !dateInput.value) {
    const today = new Date();
    dateInput.value = today.toISOString().split("T")[0];
  }
  const timeInput = $("#call-time");
  if (timeInput && !timeInput.value) {
    const now = new Date();
    now.setMinutes(Math.ceil((now.getMinutes() + 10) / 15) * 15);
    timeInput.value = now.toTimeString().slice(0, 5);
  }
  modal.classList.remove("hidden");
  const titleInput = $("#call-title");
  if (titleInput) titleInput.focus();
}

function closeScheduleCallModal() {
  const modal = $("#schedule-call-overlay");
  if (modal) modal.classList.add("hidden");
}

async function scheduleGoogleCall(e) {
  e.preventDefault();
  const title = ($("#call-title") ? $("#call-title").value : "").trim();
  const date = $("#call-date") ? $("#call-date").value : "";
  const time = $("#call-time") ? $("#call-time").value : "";
  const duration = parseInt($("#call-duration") ? $("#call-duration").value : "30", 10);
  const attendees = ($("#call-attendees") ? $("#call-attendees").value : "").trim();
  const description = ($("#call-notes") ? $("#call-notes").value : "").trim();

  if (!title || !date || !time) {
    toast("Title, date, and start time are required", "error");
    return;
  }

  const startIso = `${date}T${time}:00`;
  const submitBtn = $("#btn-call-submit");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Scheduling…";
  }

  try {
    const res = await api("/api/google/calls/schedule", {
      method: "POST",
      body: JSON.stringify({
        title,
        start_time: startIso,
        durationMinutes: duration,
        attendees,
        description
      })
    });

    toast("Call scheduled with Google Meet! 📹");
    if (res.meetLink) {
      toast(`Google Meet: ${res.meetLink}`);
    }
    closeScheduleCallModal();
    const form = $("#schedule-call-form");
    if (form) form.reset();
    await loadReminders({ silent: false });
  } catch (err) {
    toast(err.message || "Failed to schedule call", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Schedule & Create Meet";
    }
  }
}

async function init() {
  setTheme(getTheme());
  setupEvents();
  initAudioStatus();
  initNotificationControls();
  handleGoogleQueryParams();
  await loadMeta();
  await loadOAuthSetupGuide();
  await loadGoogleStatus();
  await loadUserProfile();
  await loadReminders();
  updateGoogleToneBarVisibility();
  initSSE();

  // Fast live update every 5 seconds without refreshing the whole page
  setInterval(() => {
    if (document.hidden) return;
    loadReminders({ silent: true });
    loadGoogleStatus({ silent: true });
    loadUserProfile();
  }, 5000);
}

init();
