// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const get  = (path)        => api("GET",    path);
const post = (path, body)  => api("POST",   path, body);
const patch= (path, body)  => api("PATCH",  path, body);
const del  = (path)        => api("DELETE", path);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let goals    = [];
let sessions = [];
let expanded = {};
let currentGoalId = null;

// Timer state
let timerRunning  = false;
let isBreak       = false;
let secondsLeft   = 0;
let totalSeconds  = 0;

// Alert preferences (persisted to localStorage)
let soundEnabled  = localStorage.getItem("pomo_sound") !== "false";
let notifEnabled  = localStorage.getItem("pomo_notif") !== "false";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function switchTab(t) {
  ["goals", "timer", "log"].forEach(id => {
    document.getElementById("tab-" + id).style.display = id === t ? "" : "none";
  });
  document.querySelectorAll(".tab").forEach((el, i) => {
    el.classList.toggle("active", ["goals", "timer", "log"][i] === t);
  });
  if (t === "timer") renderTimerGoalSelect();
  if (t === "log")   loadLog();
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

async function loadGoals() {
  goals = await get("/api/goals");
  refreshCatSuggestions();
  renderGoals();
}

async function addGoal() {
  const title = document.getElementById("goal-input").value.trim();
  if (!title) return;
  const rawCat = document.getElementById("goal-cat").value.trim();
  await post("/api/goals", {
    title,
    category: rawCat || "Other",
    note: document.getElementById("goal-note").value.trim(),
  });
  document.getElementById("goal-cat").value = "";
  document.getElementById("goal-input").value = "";
  document.getElementById("goal-note").value  = "";
  await loadGoals();
}

async function toggleGoalDone(id) {
  const g = goals.find(g => g.id === id);
  if (!g) return;
  await patch(`/api/goals/${id}`, { done: !g.done });
  await loadGoals();
}

async function deleteGoal(id) {
  if (!confirm("Delete this goal and all its sessions?")) return;
  await del(`/api/goals/${id}`);
  await loadGoals();
}

function toggleExpand(id) {
  expanded[id] = !expanded[id];
  renderGoals();
}

// ---------------------------------------------------------------------------
// Sub-goals
// ---------------------------------------------------------------------------

async function addSubgoal(goalId) {
  const inp  = document.getElementById("sub-inp-" + goalId);
  const text = inp.value.trim();
  if (!text) return;
  await post(`/api/goals/${goalId}/subgoals`, { title: text });
  inp.value = "";
  await loadGoals();
}

async function setSubStatus(subId, currentStatus, newStatus) {
  const status = currentStatus === newStatus ? "pending" : newStatus;
  await patch(`/api/subgoals/${subId}`, { status });
  await loadGoals();
}

async function deleteSubgoal(subId) {
  await del(`/api/subgoals/${subId}`);
  await loadGoals();
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

// Map well-known categories to badge colours; unknown ones cycle through the palette.
const CAT_PRESETS = {
  work: "badge-info", learning: "badge-warn", health: "badge-success",
  personal: "badge-info", finance: "badge-warn", creative: "badge-success", other: "badge-info",
};
const BADGE_CYCLE = ["badge-info", "badge-warn", "badge-success"];
const _catColorCache = {};

function catBadge(cat) {
  const key = (cat || "other").toLowerCase();
  if (CAT_PRESETS[key]) return CAT_PRESETS[key];
  if (!_catColorCache[key]) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    _catColorCache[key] = BADGE_CYCLE[h % BADGE_CYCLE.length];
  }
  return _catColorCache[key];
}

function catDisplay(cat) {
  if (!cat) return "Other";
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

// Keep a live list of categories seen so far to update the datalist suggestions
async function refreshCatSuggestions() {
  const seen = [...new Set(goals.map(g => g.category).filter(Boolean))];
  // Also pull any categories stored in DB that might not be in current page state
  let fromDb = [];
  try { fromDb = await get("/api/categories"); } catch (_) {}
  const defaults = ["Work","Learning","Health","Personal","Finance","Creative","Other"];
  const all = [...new Set([
    ...defaults,
    ...seen.map(c => c.charAt(0).toUpperCase() + c.slice(1)),
    ...fromDb.map(c => c.charAt(0).toUpperCase() + c.slice(1)),
  ])].sort();
  const dl = document.getElementById("cat-suggestions");
  if (dl) dl.innerHTML = all.map(c => `<option value="${esc(c)}">`).join("");
}

function formatMins(m) {
  m = Math.round(m || 0);
  const h = Math.floor(m / 60), min = m % 60;
  return h > 0 ? `${h}h ${min}m` : `${min}m`;
}

function subProgress(g) {
  const subs = g.subgoals || [];
  if (!subs.length) return null;
  const done   = subs.filter(s => s.status === "done").length;
  const failed = subs.filter(s => s.status === "failed").length;
  return { total: subs.length, done, failed };
}

function renderGoals() {
  const el = document.getElementById("goals-list");
  if (!goals.length) { el.innerHTML = '<div class="empty">No goals yet — add one above.</div>'; return; }

  el.innerHTML = goals.map(g => {
    const subs  = g.subgoals || [];
    const prog  = subProgress(g);
    const isExp = expanded[g.id];

    const progStr = prog
      ? `<span style="font-size:12px;color:var(--text-secondary)">${prog.done}/${prog.total} done${prog.failed ? ` · ${prog.failed} missed` : ""}</span>`
      : "";

    const subItems = subs.map(s => `
      <div class="sub-item ${s.status === "done" ? "done-sub" : s.status === "failed" ? "failed-sub" : ""}">
        <span class="sub-title">${esc(s.title)}</span>
        <button class="btn btn-sm ${s.status === "done" ? "btn-primary" : ""}"
          onclick="setSubStatus(${s.id},'${s.status}','done')">
          ${s.status === "done" ? "✓ Done" : "Done"}
        </button>
        <button class="btn btn-sm ${s.status === "failed" ? "btn-danger" : ""}"
          onclick="setSubStatus(${s.id},'${s.status}','failed')">
          ${s.status === "failed" ? "✕ Missed" : "Missed"}
        </button>
        <button class="btn btn-sm" style="color:var(--text-tertiary)"
          onclick="deleteSubgoal(${s.id})">×</button>
      </div>`).join("");

    const subSection = isExp ? `
      <div class="sub-list">
        ${subItems}
        <div class="sub-add-row">
          <input type="text" id="sub-inp-${g.id}" placeholder="Add sub-goal…"
            style="flex:1;font-size:13px"
            onkeydown="if(event.key==='Enter') addSubgoal(${g.id})" />
          <button class="btn btn-sm" onclick="addSubgoal(${g.id})">Add</button>
        </div>
      </div>` : "";

    return `
      <div class="card-flat" style="opacity:${g.done ? .55 : 1}">
        <div class="row">
          <input type="checkbox" ${g.done ? "checked" : ""}
            onchange="toggleGoalDone(${g.id})"
            style="cursor:pointer;width:16px;height:16px;flex-shrink:0" />
          <div class="grow">
            <div style="font-size:15px;font-weight:500;text-decoration:${g.done ? "line-through" : "none"};color:var(--text)">${esc(g.title)}</div>
            ${g.note ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${esc(g.note)}</div>` : ""}
            ${prog ? `<div style="margin-top:4px">${progStr}</div>` : ""}
          </div>
          <span class="badge ${catBadge(g.category)}">${esc(catDisplay(g.category))}</span>
          <span style="font-size:12px;color:var(--text-secondary);white-space:nowrap">${g.pomos} · ${formatMins(g.total_mins)}</span>
          <button class="expand-btn" onclick="toggleExpand(${g.id})">${isExp ? "▲" : "▼"} ${subs.length}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteGoal(${g.id})">✕</button>
        </div>
        ${subSection}
      </div>`;
  }).join("");
}

function esc(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ---------------------------------------------------------------------------
// Sound  —  Web Audio API chime (no audio files needed)
// ---------------------------------------------------------------------------

let _audioCtx = null;

function getAudioCtx() {
  // Lazily create so we don't trigger autoplay policy before user interaction
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playChime(isWorkEnd) {
  if (!soundEnabled) return;
  try {
    const ctx   = getAudioCtx();
    // Work end: ascending major arpeggio (C5 → E5 → G5 → C6)
    // Break end: two soft descending tones
    const notes = isWorkEnd
      ? [523.25, 659.25, 783.99, 1046.50]
      : [783.99, 523.25];
    const stepMs = 0.18;

    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type            = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * stepMs;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.02);   // quick attack
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45); // natural decay
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch (e) {
    console.warn("Audio playback failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Browser Notifications
// ---------------------------------------------------------------------------

async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  // Reflect actual permission in the toggle after the user responds
  syncNotifToggle();
}

function sendNotification(title, body) {
  if (!notifEnabled) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, silent: true });
    // Auto-close after 8 seconds
    setTimeout(() => n.close(), 8000);
  } catch (e) {
    console.warn("Notification failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Alert toggles
// ---------------------------------------------------------------------------

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem("pomo_sound", soundEnabled);
  syncSoundToggle();
  // Play a quick preview so the user knows it's working
  if (soundEnabled) playChime(true);
}

function toggleNotif() {
  if (!notifEnabled && Notification.permission === "default") {
    // Need to request permission first — can only do this on user gesture
    Notification.requestPermission().then(perm => {
      notifEnabled = perm === "granted";
      localStorage.setItem("pomo_notif", notifEnabled);
      syncNotifToggle();
    });
  } else {
    notifEnabled = !notifEnabled;
    localStorage.setItem("pomo_notif", notifEnabled);
    syncNotifToggle();
  }
}

function syncSoundToggle() {
  const btn  = document.getElementById("toggle-sound");
  const icon = document.getElementById("sound-icon");
  if (!btn) return;
  btn.classList.toggle("active", soundEnabled);
  btn.title = soundEnabled ? "Sound on — click to mute" : "Sound off — click to enable";
  if (icon) icon.textContent = soundEnabled ? "🔔" : "🔕";
}

function syncNotifToggle() {
  const btn   = document.getElementById("toggle-notif");
  const icon  = document.getElementById("notif-icon");
  const label = document.getElementById("notif-label");
  if (!btn) return;
  const granted = "Notification" in window && Notification.permission === "granted";
  const active  = notifEnabled && granted;
  btn.classList.toggle("active", active);
  btn.title = active ? "Notifications on — click to disable" : "Notifications off — click to enable";
  if (icon)  icon.textContent  = active ? "🔔" : "🔕";
  if (label) label.textContent = active ? "Notify" : "Notify";
  // Dim the button if browser permission was denied
  btn.style.opacity = ("Notification" in window && Notification.permission === "denied") ? "0.4" : "";
  btn.style.cursor  = ("Notification" in window && Notification.permission === "denied") ? "not-allowed" : "";
}


//
// How it works:
//   - `deadlineAt` stores the exact Date.now() timestamp when the current
//     phase (work or break) should end.
//   - A requestAnimationFrame loop runs continuously while the timer is
//     active, computing secondsLeft = ceil((deadlineAt - now) / 1000) on
//     every frame. This means the display is always derived from real wall
//     time, never from a counted tick — drift is impossible.
//   - Pausing snapshots the remaining ms; resuming shifts deadlineAt
//     forward by that amount so no time is lost.
//   - The Page Visibility API fires onVisible() whenever the tab regains
//     focus, which immediately redraws the correct time (important because
//     browsers throttle rAF in background tabs).
// ---------------------------------------------------------------------------

function getWorkSecs()  { return (parseInt(document.getElementById("pomo-work").value)  || 25) * 60; }
function getBreakSecs() { return (parseInt(document.getElementById("pomo-break").value) || 5)  * 60; }

// Wall-clock timer state
let deadlineAt    = null;  // Date.now() ms when current phase ends
let pausedMsLeft  = null;  // ms remaining when paused
let rafId         = null;  // requestAnimationFrame handle
let sessionFired  = false; // guard so onPhaseEnd runs exactly once

function initTimer() {
  stopRaf();
  isBreak      = false;
  timerRunning = false;
  deadlineAt   = null;
  pausedMsLeft = null;
  sessionFired = false;
  totalSeconds = getWorkSecs();
  secondsLeft  = totalSeconds;
  renderTimerDisplay(secondsLeft);
  document.getElementById("timer-btn").textContent = "Start";
  document.getElementById("timer-phase").textContent = "Work session";
}

// --- rAF loop ---

function startRaf() {
  if (rafId) return;
  rafId = requestAnimationFrame(rafTick);
}

function stopRaf() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function rafTick() {
  if (!timerRunning || !deadlineAt) { rafId = null; return; }

  const msLeft = deadlineAt - Date.now();
  secondsLeft  = Math.max(0, Math.ceil(msLeft / 1000));

  renderTimerDisplay(secondsLeft);

  if (msLeft <= 0 && !sessionFired) {
    sessionFired = true;
    stopRaf();
    onPhaseEnd();
    return;
  }

  rafId = requestAnimationFrame(rafTick);
}

// --- Phase transitions ---

async function onPhaseEnd() {
  timerRunning = false;
  deadlineAt   = null;

  if (!isBreak) {
    // Work phase just finished — log the session
    playChime(true);
    sendNotification("🍅 Work session complete!", "Great focus. Time to take a break.");
    const mins = parseInt(document.getElementById("pomo-work").value) || 25;
    if (currentGoalId) {
      await post("/api/sessions", { goal_id: currentGoalId, mins });
      await loadGoals();
      await updateTodayCount();
    }
    isBreak      = true;
    totalSeconds = getBreakSecs();
    secondsLeft  = totalSeconds;
    sessionFired = false;
    document.getElementById("timer-btn").textContent  = "Start break";
    document.getElementById("timer-phase").textContent = "Work complete! 🍅";
  } else {
    // Break just finished — ready for next work session
    playChime(false);
    sendNotification("⏰ Break over!", "Ready to get back to work?");
    isBreak      = false;
    totalSeconds = getWorkSecs();
    secondsLeft  = totalSeconds;
    sessionFired = false;
    document.getElementById("timer-btn").textContent  = "Start";
    document.getElementById("timer-phase").textContent = "Break over — ready?";
  }

  renderTimerDisplay(secondsLeft);
}

// --- Controls ---

function toggleTimer() {
  if (!timerRunning) {
    // Start or resume
    if (pausedMsLeft !== null) {
      // Resuming from pause — shift deadline forward by remaining time
      deadlineAt   = Date.now() + pausedMsLeft;
      pausedMsLeft = null;
    } else {
      // Fresh start
      totalSeconds = isBreak ? getBreakSecs() : getWorkSecs();
      secondsLeft  = totalSeconds;
      deadlineAt   = Date.now() + totalSeconds * 1000;
      sessionFired = false;
    }
    timerRunning = true;
    document.getElementById("timer-btn").textContent = "Pause";
    startRaf();
  } else {
    // Pause — snapshot how much time remains
    pausedMsLeft = Math.max(0, deadlineAt - Date.now());
    deadlineAt   = null;
    timerRunning = false;
    stopRaf();
    document.getElementById("timer-btn").textContent = "Resume";
  }
}

function resetTimer() {
  stopRaf();
  timerRunning = false;
  deadlineAt   = null;
  pausedMsLeft = null;
  sessionFired = false;
  isBreak      = false;
  totalSeconds = getWorkSecs();
  secondsLeft  = totalSeconds;
  document.getElementById("timer-btn").textContent  = "Start";
  document.getElementById("timer-phase").textContent = "Work session";
  renderTimerDisplay(secondsLeft);
}

// --- Display ---

function renderTimerDisplay(secs) {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60), ss = s % 60;
  document.getElementById("timer-display").textContent =
    String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
  document.getElementById("timer-progress").style.width =
    totalSeconds > 0 ? Math.min(100, Math.round((s / totalSeconds) * 100)) + "%" : "100%";
}

// --- Page Visibility API ---
// When the tab becomes visible again after being hidden, browsers may have
// throttled or paused rAF. We sync the display immediately on return so the
// user never sees a stale number, and restart the rAF loop if needed.

function onVisible() {
  if (!timerRunning || !deadlineAt) return;
  const msLeft = Math.max(0, deadlineAt - Date.now());
  secondsLeft  = Math.ceil(msLeft / 1000);
  renderTimerDisplay(secondsLeft);
  if (msLeft <= 0 && !sessionFired) {
    sessionFired = true;
    stopRaf();
    onPhaseEnd();
  } else {
    // Restart the rAF loop (it may have been suspended by the browser)
    stopRaf();
    startRaf();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") onVisible();
});

// --- Misc ---

function renderTimerGoalSelect() {
  const sel    = document.getElementById("timer-goal-select");
  const active = goals.filter(g => !g.done);
  sel.innerHTML = '<option value="">— choose a goal —</option>' +
    active.map(g => `<option value="${g.id}">${esc(g.title)}</option>`).join("");
  if (currentGoalId) sel.value = currentGoalId;
  updateTimerGoal();
}

function updateTimerGoal() {
  const sel = document.getElementById("timer-goal-select");
  currentGoalId = sel.value ? parseInt(sel.value) : null;
  const g = goals.find(g => g.id === currentGoalId);
  document.getElementById("timer-goal-name").textContent = g ? g.title : "No goal selected";

  const sec     = document.getElementById("timer-subgoals-section");
  const listEl  = document.getElementById("timer-subgoals-list");
  const pending = g ? (g.subgoals || []).filter(s => s.status === "pending") : [];

  if (g && pending.length) {
    sec.style.display = "";
    listEl.innerHTML  = pending.map(s => `
      <div class="sub-item">
        <span style="width:8px;height:8px;border-radius:50%;background:var(--text-tertiary);display:inline-block;flex-shrink:0"></span>
        <span style="font-size:13px;color:var(--text-secondary)">${esc(s.title)}</span>
      </div>`).join("");
  } else {
    sec.style.display = "none";
  }
}

async function updateTodayCount() {
  const stats = await get("/api/stats");
  document.getElementById("session-count").textContent =
    "Pomodoros today: " + stats.today_pomos;
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

async function loadLog() {
  const [stats, sessData] = await Promise.all([get("/api/stats"), get("/api/sessions")]);
  sessions = sessData;

  document.getElementById("stat-total").textContent    = stats.total_pomos;
  document.getElementById("stat-hours").textContent    = formatMins(stats.total_mins);
  document.getElementById("stat-subgoals").textContent = stats.sub_pct !== null ? stats.sub_pct + "%" : "—";

  const goalLogEl = document.getElementById("log-by-goal");
  if (!stats.by_goal.length) {
    goalLogEl.innerHTML = '<div class="empty" style="padding:1rem 0">No data yet.</div>';
  } else {
    const max = Math.max(...stats.by_goal.map(g => g.mins));
    goalLogEl.innerHTML = stats.by_goal.filter(g => g.mins > 0).map(g => {
      const pct = Math.round((g.mins / max) * 100);
      return `
        <div class="card-flat" style="margin-bottom:6px">
          <div class="row" style="margin-bottom:6px">
            <span class="grow" style="font-size:14px;font-weight:500">${esc(g.title)}</span>
            <span style="font-size:12px;color:var(--text-secondary)">${g.pomos} pomodoros · ${formatMins(g.mins)}</span>
          </div>
          <div class="pb-bg" style="margin-bottom:0"><div class="pb-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join("") || '<div class="empty" style="padding:1rem 0">No sessions yet.</div>';
  }

  const logEl = document.getElementById("log-list");
  if (!sessions.length) { logEl.innerHTML = '<div class="empty">No sessions logged yet.</div>'; return; }
  logEl.innerHTML = sessions.map(s => `
    <div class="log-row">
      <div>
        <div style="font-weight:500;font-size:14px">${esc(s.goal_title || "Deleted goal")}</div>
        <div style="color:var(--text-secondary);font-size:12px">${s.date} · ${s.ts}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:14px">${s.mins} min</div>
        <span class="badge badge-success" style="font-size:10px">done</span>
      </div>
    </div>`).join("");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadGoals();
  initTimer();
  updateTodayCount();

  // Initialise alert toggles
  syncSoundToggle();
  syncNotifToggle();

  // Request notification permission on load (only prompts if "default")
  await requestNotificationPermission();

  document.getElementById("goal-input").addEventListener("keydown", e => {
    if (e.key === "Enter") addGoal();
  });
});