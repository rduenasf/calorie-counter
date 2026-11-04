import { getDay, addEntry, updateEntry, deleteEntry, allDays, importDays } from "./db.js";
import { tryEvaluate } from "./calc.js";
import { estimateCalories, prepareImage } from "./ai.js";

const $ = (id) => document.getElementById(id);

const settings = {
  get apiKey() { return localStorage.getItem("geminiKey") ?? ""; },
  set apiKey(v) { localStorage.setItem("geminiKey", v); localStorage.removeItem("apiKey"); },
  get goal() { return Number(localStorage.getItem("goal")) || 0; },
  set goal(v) { localStorage.setItem("goal", String(v || "")); },
};

// ---------- dates ----------

function toKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shiftKey(key, days) {
  const d = fromKey(key);
  d.setDate(d.getDate() + days);
  return toKey(d);
}

// Weeks run Monday–Sunday.
function weekStartKey(key) {
  const offset = (fromKey(key).getDay() + 6) % 7; // Mon = 0 … Sun = 6
  return shiftKey(key, -offset);
}

function labelFor(key) {
  const today = toKey(new Date());
  if (key === today) return "Today";
  if (key === shiftKey(today, -1)) return "Yesterday";
  if (key === shiftKey(today, 1)) return "Tomorrow";
  return fromKey(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

let currentDate = toKey(new Date());

// ---------- rendering ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const fmt = (n) => Math.round(n).toLocaleString();

const fmtTime = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const dayTotal = (day) => day.entries.reduce((sum, e) => sum + (Number(e.kcal) || 0), 0);

// Warn within 25% of the daily goal of the budget, alert once over.
const statusFor = (total, budget, goal) => (total > budget ? "over" : budget - total <= goal * 0.25 ? "near" : "");

async function renderWeek(goal) {
  $("open-week").hidden = !goal;
  if (!goal) return;

  const start = weekStartKey(currentDate);
  const keys = Array.from({ length: 7 }, (_, i) => shiftKey(start, i));
  const totals = await Promise.all(keys.map(async (k) => dayTotal(await getDay(k))));
  const today = toKey(new Date());

  const budget = goal * 7;
  const weekTotal = totals.reduce((a, b) => a + b, 0);
  const left = budget - weekTotal;
  const status = statusFor(weekTotal, budget, goal);

  const end = keys[6];
  const short = (k) => fromKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  $("week-title").textContent =
    today >= start && today <= end ? "This week" : `Week of ${short(start)} – ${short(end)}`;
  $("week-count").textContent = `${fmt(weekTotal)} / ${fmt(budget)}`;
  $("week-count").className = `week-count ${status}`;
  $("week-total").textContent = `${fmt(weekTotal)} / ${fmt(budget)} kcal`;
  $("week-left").textContent = left >= 0 ? `${fmt(left)} left` : `${fmt(-left)} over`;
  $("week-left").className = `week-left ${status}`;
  $("week-fill").style.width = `${Math.min(100, (weekTotal / budget) * 100)}%`;
  $("week-fill").className = `fill ${status}`;

  // One mini bar per day; the goal line sits at 2/3 height so overs stay visible.
  $("week-days").innerHTML = keys
    .map((k, i) => {
      const t = totals[i];
      const h = Math.min(100, (t / goal) * (200 / 3));
      const cls = [k === currentDate && "selected", k === today && "today"].filter(Boolean).join(" ");
      const name = fromKey(k).toLocaleDateString(undefined, { weekday: "narrow" });
      return `
        <button type="button" class="wd ${cls}" data-date="${k}" aria-label="${labelFor(k)}: ${fmt(t)} kcal">
          <span class="wd-kcal">${t ? fmt(t) : ""}</span>
          <span class="wd-bar"><span class="wd-fill ${t > goal ? "over" : ""}" style="height:${h}%"></span></span>
          <span class="wd-name">${name}</span>
        </button>`;
    })
    .join("");

  // The balancing tip: spread what's left of the week over today and the days after it.
  // Days before today count as they were logged; today's partial total is part of the remainder.
  let tip;
  if (today > end) {
    tip = left >= 0
      ? `Week finished ${fmt(left)} kcal under budget.`
      : `Week finished ${fmt(-left)} kcal over budget.`;
  } else {
    const firstOpen = today < start ? 0 : keys.indexOf(today);
    const daysLeft = 7 - firstOpen;
    const loggedBefore = totals.slice(0, firstOpen).reduce((a, b) => a + b, 0);
    const perDay = (budget - loggedBefore) / daysLeft;
    const diff = perDay - goal;
    const when = daysLeft === 1 ? "today" : today < start ? "each day" : `a day for the ${daysLeft} days left`;
    if (perDay <= 0) tip = `Weekly budget already used up — ${fmt(-perDay * daysLeft)} kcal over.`;
    else if (Math.abs(diff) < 1) tip = `On track: ${fmt(goal)} kcal ${when}.`;
    else
      tip = `To balance the week: ~${fmt(perDay)} kcal ${when} (${fmt(Math.abs(diff))} ${diff < 0 ? "below" : "above"} your daily goal).`;
  }
  $("week-tip").textContent = tip;
}

async function render() {
  const day = await getDay(currentDate);
  $("date-label").textContent = labelFor(currentDate);
  $("date-picker").value = currentDate;

  const total = dayTotal(day);
  $("total").textContent = fmt(total);

  const goal = settings.goal;
  await renderWeek(goal);
  const status = goal ? statusFor(total, goal, goal) : "";
  $("total").className = status;
  $("goal-total").textContent = goal ? ` / ${fmt(goal)}` : "";
  $("goal-wrap").hidden = !goal;
  if (goal) {
    $("goal-fill").style.width = `${Math.min(100, (total / goal) * 100)}%`;
    $("goal-fill").className = `fill ${status}`;
  }

  $("empty").hidden = day.entries.length > 0;
  $("entries").innerHTML = [...day.entries]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)) // newest at the top
    .map(
      (e) => `
      <li class="entry" data-id="${e.id}">
        <span class="entry-time">${e.createdAt ? fmtTime(e.createdAt) : ""}</span>
        <div class="entry-main">
          <div class="entry-name">${escapeHtml(e.name || "Food")}</div>
          ${e.note ? `<div class="entry-note">${escapeHtml(e.note)}</div>` : ""}
        </div>
        <div class="entry-kcal">${fmt(e.kcal)}</div>
      </li>`
    )
    .join("");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2500);
}

// ---------- date nav ----------

$("prev-day").onclick = () => { currentDate = shiftKey(currentDate, -1); render(); };
$("next-day").onclick = () => { currentDate = shiftKey(currentDate, 1); render(); };
$("date-label").onclick = () => {
  const p = $("date-picker");
  if (p.showPicker) p.showPicker(); else p.click();
};
$("date-picker").onchange = (e) => {
  if (e.target.value) { currentDate = e.target.value; render(); }
};

$("week-days").onclick = (e) => {
  const date = e.target.closest("[data-date]")?.dataset.date;
  if (date && date !== currentDate) { currentDate = date; render(); }
};

$("open-week").onclick = () => $("week-sheet").showModal();

// Jump back to today when the app is reopened on a new day.
let lastSeenToday = toKey(new Date());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const today = toKey(new Date());
  if (today !== lastSeenToday) {
    if (currentDate === lastSeenToday) currentDate = today;
    lastSeenToday = today;
    render();
  }
});

// ---------- sheets ----------

for (const btn of document.querySelectorAll("[data-close]")) {
  btn.onclick = () => btn.closest("dialog").close();
}
// Tap on the backdrop closes the sheet.
for (const dlg of document.querySelectorAll("dialog.sheet")) {
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}

// ---------- calculator ----------

let calcExpr = "";
let editingId = null;
let editingAi = false;
let calcPrior = null; // { expr, result } from the last "=", which collapses calcExpr to its result

// The full calculation behind calcExpr, including what "=" collapsed.
function calcSteps() {
  if (!calcPrior) return calcExpr;
  if (calcExpr === calcPrior.result) return calcPrior.expr;
  const rest = calcExpr.slice(calcPrior.result.length);
  if (!calcExpr.startsWith(calcPrior.result) || !/^[+−×÷]/.test(rest)) return calcExpr;
  return /^[×÷]/.test(rest) && /[+−]/.test(calcPrior.expr) ? `(${calcPrior.expr})${rest}` : calcPrior.expr + rest;
}

function renderCalc() {
  $("calc-expr").textContent = calcExpr || " ";
  const v = tryEvaluate(calcExpr);
  $("calc-result").textContent = v === null ? (calcExpr ? "…" : "0") : fmt(v);
  const ok = v !== null && v >= 0;
  $("calc-save").disabled = !ok;
  $("calc-save").textContent = `${editingId ? "Save" : "Add"}${ok ? ` ${fmt(v)} kcal` : ""}`;
}

function openCalc(entry) {
  editingId = entry?.id ?? null;
  editingAi = entry?.source === "ai";
  calcPrior = null;
  // Manual entries reopen with their calculation; AI notes are prose, so those start from the number.
  calcExpr = !entry ? "" : !editingAi && entry.note ? entry.note : String(entry.kcal);
  $("calc-name").value = entry?.name ?? "";
  $("calc-title").textContent = entry ? "Edit entry" : "Add food";
  $("calc-delete").hidden = !entry;
  renderCalc();
  $("calc-sheet").showModal();
  $("calc-name").blur();
}

function pressKey(key) {
  if (key === "C") { calcExpr = ""; calcPrior = null; }
  else if (key === "back") calcExpr = calcExpr.slice(0, -1);
  else if (key === "=") {
    const v = tryEvaluate(calcExpr);
    if (v !== null) {
      const result = String(Math.round(v * 100) / 100);
      calcPrior = { expr: calcSteps(), result };
      calcExpr = result;
    }
  } else calcExpr += key;
  renderCalc();
}

// Keys react on pointerdown instead of click: on touch screens click only fires
// after the finger lifts, which makes fast typing feel laggy.
$("keypad").addEventListener("pointerdown", (e) => {
  const btn = e.target.closest("[data-key]");
  if (!btn) return;
  e.preventDefault(); // keep focus where it is, no text selection
  btn.classList.add("pressed");
  pressKey(btn.dataset.key);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
  $("keypad").addEventListener(type, () => {
    for (const b of $("keypad").querySelectorAll(".pressed")) b.classList.remove("pressed");
  });
}
// Keyboard activation (Enter/Space on a focused key) still arrives as a click with detail 0.
$("keypad").onclick = (e) => {
  const key = e.target.closest("[data-key]")?.dataset.key;
  if (key && e.detail === 0) pressKey(key);
};

// Physical keyboard support while the calculator is open (desktop use).
$("calc-sheet").addEventListener("keydown", (e) => {
  if (e.target === $("calc-name")) return;
  const map = { "*": "×", "/": "÷", "-": "−", Backspace: "back", Enter: "=", Escape: null };
  if (/^[0-9.+()]$/.test(e.key)) pressKey(e.key);
  else if (e.key in map && map[e.key]) pressKey(map[e.key]);
  else return;
  e.preventDefault();
});

$("open-calc").onclick = () => openCalc(null);

$("calc-form").onsubmit = async (e) => {
  e.preventDefault();
  const v = tryEvaluate(calcExpr);
  if (v === null || v < 0) return;
  const kcal = Math.round(v);
  const name = $("calc-name").value.trim() || "Food";
  // A plain number has no operations to record, so it leaves (or clears to) an empty note.
  const steps = calcSteps();
  const note = /[+−×÷]/.test(steps) ? steps : "";
  if (editingId) await updateEntry(currentDate, editingId, editingAi ? { name, kcal } : { name, kcal, note });
  else await addEntry(currentDate, { name, kcal, source: "manual", note });
  $("calc-sheet").close();
  render();
};

$("calc-delete").onclick = async () => {
  if (!editingId || !confirm("Delete this entry?")) return;
  await deleteEntry(currentDate, editingId);
  $("calc-sheet").close();
  render();
};

$("entries").onclick = async (e) => {
  const id = e.target.closest(".entry")?.dataset.id;
  if (!id) return;
  const day = await getDay(currentDate);
  const entry = day.entries.find((x) => x.id === id);
  if (entry) openCalc(entry);
};

// ---------- AI estimate ----------

let aiPhoto = null; // File
let aiNotes = "";

function resetAi() {
  $("ai-desc").value = "";
  $("ai-weight").value = "";
  aiPhoto = null;
  $("ai-preview").hidden = true;
  $("ai-camera-label").textContent = "📷 Take photo";
  showAiStep("input");
}

function showAiStep(step) {
  $("ai-input").hidden = step !== "input";
  $("ai-result").hidden = step !== "result";
  $("ai-error").hidden = true;
}

function aiError(msg) {
  $("ai-error").textContent = msg;
  $("ai-error").hidden = false;
}

$("open-ai").onclick = () => {
  resetAi();
  $("ai-sheet").showModal();
  if (!settings.apiKey) aiError("Add your Gemini API key in Settings first.");
};

// Two inputs: "ai-camera" opens the camera directly (capture attribute), "ai-photo" opens the gallery.
function onPhotoPicked(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  aiPhoto = file;
  const img = $("ai-preview");
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(aiPhoto);
  img.hidden = false;
  $("ai-camera-label").textContent = "📷 Retake";
}
$("ai-camera").onchange = onPhotoPicked;
$("ai-photo").onchange = onPhotoPicked;

$("ai-go").onclick = async () => {
  const description = $("ai-desc").value.trim();
  const weight = $("ai-weight").value.trim();
  if (!settings.apiKey) return aiError("Add your Gemini API key in Settings first.");
  if (!description && !aiPhoto) return aiError("Add a description or a photo.");

  const btn = $("ai-go");
  btn.disabled = true;
  btn.textContent = "Estimating…";
  $("ai-error").hidden = true;
  // Show elapsed seconds so a slow call is visibly still working.
  const started = Date.now();
  const ticker = setInterval(() => {
    btn.textContent = `Estimating… ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  try {
    const imageBase64 = aiPhoto ? (await prepareImage(aiPhoto)).base64 : null;
    const result = await estimateCalories({ apiKey: settings.apiKey, description, weight, imageBase64 });
    $("ai-name").value = result.name;
    $("ai-kcal").value = result.kcal;
    aiNotes = result.notes;
    $("ai-notes").textContent = result.notes;
    showAiStep("result");
  } catch (err) {
    aiError(err.message || String(err));
  } finally {
    clearInterval(ticker);
    btn.disabled = false;
    btn.textContent = "Estimate calories";
  }
};

$("ai-back").onclick = () => showAiStep("input");

$("ai-form").onsubmit = async (e) => {
  e.preventDefault();
  const kcal = Math.round(Number($("ai-kcal").value));
  if (!Number.isFinite(kcal) || kcal < 0) return aiError("Enter a valid calorie number.");
  const weight = $("ai-weight").value.trim();
  await addEntry(currentDate, {
    name: $("ai-name").value.trim() || "Food",
    kcal,
    source: "ai",
    note: [weight, aiNotes].filter(Boolean).join(" · "),
  });
  $("ai-sheet").close();
  render();
};

// ---------- settings ----------

$("open-settings").onclick = () => {
  $("set-key").value = settings.apiKey;
  $("set-goal").value = settings.goal || "";
  $("settings-sheet").showModal();
};

$("settings-form").onsubmit = (e) => {
  e.preventDefault();
  settings.apiKey = $("set-key").value.trim();
  settings.goal = Math.max(0, Math.round(Number($("set-goal").value) || 0));
  $("settings-sheet").close();
  toast("Settings saved");
  render();
};

$("export").onclick = async () => {
  const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), days: await allDays() });
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `calorie-log-${toKey(new Date())}.json` });
  a.click();
  URL.revokeObjectURL(url);
};

$("import").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const days = Array.isArray(data) ? data : data.days;
    if (!Array.isArray(days)) throw new Error("Not a backup file");
    if (!confirm(`Import ${days.length} day(s)? Days in the backup replace the same days here.`)) return;
    await importDays(days);
    toast(`Imported ${days.length} day(s)`);
    render();
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
};

// ---------- boot ----------

render();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("./sw.js");
}
