import { getDay, addEntry, updateEntry, deleteEntry, allDays, importDays } from "./db.js";
import { tryEvaluate } from "./calc.js";
import { estimateCalories, prepareImage } from "./ai.js";

const $ = (id) => document.getElementById(id);

const settings = {
  get apiKey() { return localStorage.getItem("apiKey") ?? ""; },
  set apiKey(v) { localStorage.setItem("apiKey", v); },
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

async function render() {
  const day = await getDay(currentDate);
  $("date-label").textContent = labelFor(currentDate);
  $("date-picker").value = currentDate;

  const total = day.entries.reduce((sum, e) => sum + (Number(e.kcal) || 0), 0);
  $("total").textContent = fmt(total);

  const goal = settings.goal;
  // Warn when the total is within 500 kcal of the goal, alert once it's over.
  const status = !goal ? "" : total > goal ? "over" : goal - total <= 500 ? "near" : "";
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
  calcExpr = entry ? String(entry.kcal) : "";
  $("calc-name").value = entry?.name ?? "";
  $("calc-title").textContent = entry ? "Edit entry" : "Add food";
  $("calc-delete").hidden = !entry;
  renderCalc();
  $("calc-sheet").showModal();
  $("calc-name").blur();
}

function pressKey(key) {
  if (key === "C") calcExpr = "";
  else if (key === "back") calcExpr = calcExpr.slice(0, -1);
  else if (key === "=") {
    const v = tryEvaluate(calcExpr);
    if (v !== null) calcExpr = String(Math.round(v * 100) / 100);
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
  if (editingId) await updateEntry(currentDate, editingId, { name, kcal });
  else await addEntry(currentDate, { name, kcal, source: "manual" });
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
  $("ai-photo").value = "";
  aiPhoto = null;
  $("ai-preview").hidden = true;
  $("ai-photo-label").textContent = "📷 Add photo (optional)";
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
  if (!settings.apiKey) aiError("Add your Anthropic API key in Settings first.");
};

$("ai-photo").onchange = () => {
  aiPhoto = $("ai-photo").files[0] ?? null;
  const img = $("ai-preview");
  if (aiPhoto) {
    img.src = URL.createObjectURL(aiPhoto);
    img.hidden = false;
    $("ai-photo-label").textContent = "Change photo";
  } else {
    img.hidden = true;
  }
};

$("ai-go").onclick = async () => {
  const description = $("ai-desc").value.trim();
  const weight = $("ai-weight").value.trim();
  if (!settings.apiKey) return aiError("Add your Anthropic API key in Settings first.");
  if (!description && !aiPhoto) return aiError("Add a description or a photo.");

  const btn = $("ai-go");
  btn.disabled = true;
  btn.textContent = "Estimating…";
  $("ai-error").hidden = true;
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
