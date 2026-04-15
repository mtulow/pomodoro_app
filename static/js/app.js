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
let categories = [];
let currentGoalId = null;
let currentSubgoalId = null;   // track selected subgoal in timer

// Timer state
let timerInterval = null;
let timerRunning  = false;
let isBreak       = false;
let secondsLeft   = 0;
let totalSeconds  = 0;

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
// Categories
// ---------------------------------------------------------------------------

async function loadCategories() {
  try {
    categories = await get("/api/categories");
    const datalist = document.getElementById("category-suggestions");
    datalist.innerHTML = categories.map(c => `<option value="${esc(c)}">`).join("");
  } catch (e) { /* endpoint might not exist yet; ignore */ }
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

async function loadGoals() {
  goals = await get("/api/goals");
  renderGoals();
  renderTimerGoalSelect(); // update timer dropdown
}

async function addGoal() {
  const title = document.getElementById("goal-input").value.trim();
  if (!title) return;
  const category = document.getElementById("goal-cat").value.trim() || "General";
  const note = document.getElementById("goal-note").value.trim();
  await post("/api/goals", { title, category, note });
  document.getElementById("goal-input").value = "";
  document.getElementById("goal-cat").value = "";
  document.getElementById("goal-note").value = "";
  await loadCategories(); // refresh datalist if new category
  await loadGoals();
}

// Called from edit button inside goal card
function editGoal(btn) {
  const card = btn.closest(".goal-card");
  const goalId = parseInt(card.dataset.goalId);
  const goal = goals.find(g => g.id === goalId);
  if (!goal) return;
  // Simple prompt-based edit (could be improved)
  const newTitle = prompt("Edit goal title:", goal.title);
  if (newTitle !== null && newTitle.trim()) {
    patch(`/api/goals/${goalId}`, { title: newTitle.trim() }).then(loadGoals);
  }
}

// Called from delete button inside goal card
async function deleteGoal(btn) {
  const card = btn.closest(".goal-card");
  const goalId = parseInt(card.dataset.goalId);
  if (!confirm("Delete this goal and all its sessions?")) return;
  await del(`/api/goals/${goalId}`);
  await loadGoals();
}

async function toggleGoalDone(goalId, checked) {
  await patch(`/api/goals/${goalId}`, { done: checked });
  await loadGoals();
}

// ---------------------------------------------------------------------------
// Sub-goals
// ---------------------------------------------------------------------------

function toggleAddSubgoal(btn) {
  const card = btn.closest(".goal-card");
  const form = card.querySelector(".add-subgoal-form");
  form.style.display = form.style.display === "none" ? "block" : "none";
  if (form.style.display === "block") {
    form.querySelector(".subgoal-title-input").focus();
  }
}

async function addSubgoal(btn) {
  const card = btn.closest(".goal-card");
  const goalId = parseInt(card.dataset.goalId);
  const form = card.querySelector(".add-subgoal-form");
  const titleInput = form.querySelector(".subgoal-title-input");
  const noteInput = form.querySelector(".subgoal-note-input");
  const title = titleInput.value.trim();
  if (!title) return;

  const body = { title };
  if (noteInput.value.trim()) body.note = noteInput.value.trim();

  await post(`/api/goals/${goalId}/subgoals`, body);
  titleInput.value = "";
  noteInput.value = "";
  form.style.display = "none";
  await loadGoals();
}

async function updateSubgoalStatus(radio) {
  const subgoalEl = radio.closest(".subgoal-item");
  const subgoalId = parseInt(subgoalEl.dataset.subgoalId);
  const status = radio.value; // 'pending', 'done', 'failed'
  await patch(`/api/subgoals/${subgoalId}`, { status });
  await loadGoals();
}

async function deleteSubgoal(btn) {
  const subgoalEl = btn.closest(".subgoal-item");
  const subgoalId = parseInt(subgoalEl.dataset.subgoalId);
  if (!confirm("Delete this sub-goal?")) return;
  await del(`/api/subgoals/${subgoalId}`);
  await loadGoals();
}

async function editSubgoalNote(btn) {
  const subgoalEl = btn.closest(".subgoal-item");
  const subgoalId = parseInt(subgoalEl.dataset.subgoalId);
  const noteSpan = subgoalEl.querySelector(".subgoal-note span");
  const currentNote = noteSpan.textContent;
  const newNote = prompt("Edit note:", currentNote);
  if (newNote !== null) {
    await fetch(`/api/subgoals/${subgoalId}/note`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: newNote.trim() })
    });
    await loadGoals();
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

const catColors = { 
  work: "badge-info", learning: "badge-warn", health: "badge-success", 
  personal: "badge-info", general: "badge-secondary", other: "badge-secondary" 
};

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
  const container = document.getElementById("goals-list");
  if (!goals.length) {
    container.innerHTML = '<div class="empty">No goals yet — add one above.</div>';
    return;
  }

  const template = document.getElementById("goal-card-template");
  container.innerHTML = "";

  goals.forEach(g => {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector(".goal-card");
    card.dataset.goalId = g.id;

    // Goal header
    card.querySelector(".goal-title").textContent = g.title;
    const catSpan = card.querySelector(".goal-category");
    catSpan.textContent = g.category || "General";
    catSpan.classList.add("badge", catColors[g.category?.toLowerCase()] || "badge-secondary");

    // Note
    const noteDiv = card.querySelector(".goal-note");
    if (g.note) {
      noteDiv.textContent = g.note;
      noteDiv.style.display = "block";
    } else {
      noteDiv.style.display = "none";
    }

    // Stats
    card.querySelector(".pomo-count").textContent = g.pomos || 0;
    card.querySelector(".mins-count").textContent = g.total_mins || 0;

    // Subgoals list
    const subs = g.subgoals || [];
    const subgoalsList = card.querySelector(".subgoals-list");
    const subTemplate = document.getElementById("subgoal-item-template");

    subs.forEach(s => {
      const subClone = subTemplate.content.cloneNode(true);
      const subEl = subClone.querySelector(".subgoal-item");
      subEl.dataset.subgoalId = s.id;

      const titleSpan = subEl.querySelector(".subgoal-title");
      titleSpan.textContent = s.title;
      if (s.status === "done") titleSpan.style.textDecoration = "line-through";

      // Radio buttons
      const radios = subEl.querySelectorAll(".subgoal-radio");
      radios.forEach(r => {
        r.checked = (r.value === s.status);
        r.name = `subgoal-status-${s.id}`; // unique per subgoal
      });

      // Pomodoro count if any
      const pomoSpan = subEl.querySelector(".subgoal-pomos");
      if (s.pomos > 0) {
        pomoSpan.textContent = `🍅 ${s.pomos}`;
      }

      // Note
      const noteDiv = subEl.querySelector(".subgoal-note span");
      if (s.note) {
        noteDiv.textContent = s.note;
        noteDiv.parentElement.style.display = "flex";
      } else {
        noteDiv.parentElement.style.display = "none";
      }

      subgoalsList.appendChild(subEl);
    });

    // Done checkbox in goal header? Not in template, but we can add one
    // The template doesn't have a done checkbox; we'll add it programmatically
    const header = card.querySelector(".goal-header");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = g.done;
    checkbox.style.marginRight = "8px";
    checkbox.addEventListener("change", (e) => toggleGoalDone(g.id, e.target.checked));
    header.insertBefore(checkbox, header.firstChild);

    container.appendChild(card);
  });
}

function esc(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

function getWorkSecs()  { return (parseInt(document.getElementById("pomo-work").value)  || 25) * 60; }
function getBreakSecs() { return (parseInt(document.getElementById("pomo-break").value) || 5)  * 60; }

function initTimer() {
  isBreak     = false;
  secondsLeft = totalSeconds = getWorkSecs();
  renderTimerDisplay();
}

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

  const sec    = document.getElementById("timer-subgoals-section");
  const listEl = document.getElementById("timer-subgoals-list");
  const noteDiv = document.getElementById("timer-subgoal-note");
  const pending = g ? (g.subgoals || []).filter(s => s.status === "pending") : [];

  if (g && pending.length) {
    sec.style.display = "block";
    listEl.innerHTML = pending.map(s => `
      <div class="subgoal-selector" data-subgoal-id="${s.id}" onclick="selectTimerSubgoal(${s.id})">
        <span class="subgoal-selector-title">${esc(s.title)}</span>
        ${s.note ? '<i class="fas fa-sticky-note"></i>' : ''}
      </div>`).join("");
    // If a subgoal was previously selected, highlight it
    if (currentSubgoalId) {
      const selectedEl = listEl.querySelector(`[data-subgoal-id="${currentSubgoalId}"]`);
      if (selectedEl) selectedEl.classList.add("selected");
    }
  } else {
    sec.style.display = "none";
    noteDiv.style.display = "none";
    currentSubgoalId = null;
  }
}

function selectTimerSubgoal(subgoalId) {
  currentSubgoalId = subgoalId;
  const g = goals.find(g => g.id === currentGoalId);
  const sub = g?.subgoals?.find(s => s.id === subgoalId);
  const noteDiv = document.getElementById("timer-subgoal-note");
  if (sub && sub.note) {
    noteDiv.innerHTML = `<i class="fas fa-sticky-note"></i> ${esc(sub.note)}`;
    noteDiv.style.display = "block";
  } else {
    noteDiv.style.display = "none";
  }
  // Highlight selected
  document.querySelectorAll("#timer-subgoals-list .subgoal-selector").forEach(el => {
    el.classList.toggle("selected", el.dataset.subgoalId == subgoalId);
  });
}

function renderTimerDisplay() {
  const m = Math.floor(secondsLeft / 60), s = secondsLeft % 60;
  document.getElementById("timer-display").textContent =
    String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
  document.getElementById("timer-progress").style.width =
    Math.round((secondsLeft / totalSeconds) * 100) + "%";
  document.getElementById("timer-phase").textContent =
    isBreak ? "Break time" : "Work session";
}

async function updateTodayCount() {
  const stats = await get("/api/stats");
  document.getElementById("session-count").textContent =
    "Pomodoros today: " + stats.today_pomos;
}

function toggleTimer() {
  if (!timerRunning) {
    if (!secondsLeft) secondsLeft = totalSeconds = isBreak ? getBreakSecs() : getWorkSecs();
    timerRunning = true;
    document.getElementById("timer-btn").textContent = "Pause";
    timerInterval = setInterval(tick, 1000);
  } else {
    clearInterval(timerInterval);
    timerRunning = false;
    document.getElementById("timer-btn").textContent = "Resume";
  }
}

async function tick() {
  secondsLeft--;
  if (secondsLeft <= 0) {
    clearInterval(timerInterval);
    timerRunning = false;
    if (!isBreak) {
      const mins = parseInt(document.getElementById("pomo-work").value) || 25;
      if (currentGoalId) {
        const sessionData = { goal_id: currentGoalId, mins };
        if (currentSubgoalId) sessionData.subgoal_id = currentSubgoalId;
        await post("/api/sessions", sessionData);
        await loadGoals();
        await updateTodayCount();
      }
      isBreak     = true;
      secondsLeft = totalSeconds = getBreakSecs();
      document.getElementById("timer-btn").textContent = "Start break";
      document.getElementById("timer-phase").textContent = "Work complete!";
    } else {
      isBreak     = false;
      secondsLeft = totalSeconds = getWorkSecs();
      document.getElementById("timer-btn").textContent = "Start";
    }
  }
  renderTimerDisplay();
}

function resetTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  isBreak      = false;
  secondsLeft  = totalSeconds = getWorkSecs();
  document.getElementById("timer-btn").textContent = "Start";
  renderTimerDisplay();
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

  // Category breakdown
  const catLogEl = document.getElementById("log-by-category");
  if (stats.categories && stats.categories.length) {
    catLogEl.innerHTML = stats.categories.map(cat => `
      <div class="log-row">
        <span>${esc(cat.category)}</span>
        <span class="badge">${cat.count} goals</span>
      </div>`).join("");
  } else {
    catLogEl.innerHTML = '<div class="empty">No categories yet.</div>';
  }

  // Goal breakdown
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

  // Session history
  const logEl = document.getElementById("log-list");
  if (!sessions.length) {
    logEl.innerHTML = '<div class="empty">No sessions logged yet.</div>';
    return;
  }
  logEl.innerHTML = sessions.map(s => `
    <div class="log-row">
      <div>
        <div style="font-weight:500;font-size:14px">${esc(s.goal_title || "Deleted goal")}</div>
        ${s.subgoal_title ? `<div style="font-size:12px;color:var(--text-secondary)">↳ ${esc(s.subgoal_title)}</div>` : ""}
        <div style="color:var(--text-secondary);font-size:12px">${s.date} · ${s.ts}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:14px">${s.mins} min</div>
        <span class="badge badge-success" style="font-size:10px">🍅</span>
      </div>
    </div>`).join("");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadCategories();
  await loadGoals();
  initTimer();
  updateTodayCount();

  document.getElementById("goal-input").addEventListener("keydown", e => {
    if (e.key === "Enter") addGoal();
  });

  // Expose functions for inline onclick handlers
  window.switchTab = switchTab;
  window.addGoal = addGoal;
  window.editGoal = editGoal;
  window.deleteGoal = deleteGoal;
  window.toggleAddSubgoal = toggleAddSubgoal;
  window.addSubgoal = addSubgoal;
  window.updateSubgoalStatus = updateSubgoalStatus;
  window.deleteSubgoal = deleteSubgoal;
  window.editSubgoalNote = editSubgoalNote;
  window.selectTimerSubgoal = selectTimerSubgoal;
  window.toggleTimer = toggleTimer;
  window.resetTimer = resetTimer;
  window.updateTimerGoal = updateTimerGoal;
});