// Tiny IndexedDB wrapper. One record per day, keyed by local date "YYYY-MM-DD":
// { date, invalid?: true, invalidAt?, entries: [{ id, name, kcal, source: "manual" | "ai", note, thumb?, createdAt, updatedAt }] }
// An invalid day keeps its entries but is left out of the weekly total and budget.
// thumb is a small JPEG data URL of the AI photo. invalidAt and updatedAt let sync pick the newer side.
//
// Every local change also calls the change listener (set by sync.js) so it can be pushed.
// The apply* functions write changes that came from sync, and don't call it.

const DB_NAME = "calorie-counter";
const STORE = "days";

let dbPromise;
let onChange = () => {};

// fn({ kind: "entry", id, date, at }) or fn({ kind: "day", date, at })
export function setChangeListener(fn) {
  onChange = fn;
}

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "date" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getDay(date) {
  const db = await open();
  const day = await wrap(db.transaction(STORE).objectStore(STORE).get(date));
  return day ?? { date, entries: [] };
}

export function putDay(day) {
  return tx("readwrite", (store) => store.put(day));
}

// Read, change and write one day in a single transaction, so changes arriving from sync
// and from the UI at the same moment can't overwrite each other. fn changes day in place.
function mutateDay(date, fn) {
  return tx("readwrite", (store) => new Promise((resolve, reject) => {
    const req = store.get(date);
    req.onsuccess = () => {
      const day = req.result ?? { date, entries: [] };
      fn(day);
      store.put(day);
      resolve(day);
    };
    req.onerror = () => reject(req.error);
  }));
}

function setInvalid(day, invalid, at) {
  if (invalid) day.invalid = true;
  else delete day.invalid;
  day.invalidAt = at;
}

export async function setDayInvalid(date, invalid) {
  const at = Date.now();
  await mutateDay(date, (day) => setInvalid(day, invalid, at));
  onChange({ kind: "day", date, at });
}

export async function addEntry(date, entry) {
  const now = Date.now();
  const added = { id: crypto.randomUUID(), createdAt: now, ...entry, updatedAt: now };
  const day = await mutateDay(date, (d) => d.entries.push(added));
  onChange({ kind: "entry", id: added.id, date, at: now });
  return day;
}

export async function updateEntry(date, id, patch) {
  const now = Date.now();
  const day = await mutateDay(date, (d) => {
    d.entries = d.entries.map((e) => (e.id === id ? { ...e, ...patch, updatedAt: now } : e));
  });
  onChange({ kind: "entry", id, date, at: now });
  return day;
}

export async function deleteEntry(date, id) {
  const at = Date.now();
  const day = await mutateDay(date, (d) => {
    d.entries = d.entries.filter((e) => e.id !== id);
  });
  onChange({ kind: "entry", id, date, at });
  return day;
}

export async function allDays() {
  const db = await open();
  return wrap(db.transaction(STORE).objectStore(STORE).getAll());
}

// Days in the backup replace the same days here. Everything they touch, including
// entries they drop, counts as changed now, so sync pushes the backup's version.
export async function importDays(days) {
  const valid = days.filter((d) => d && typeof d.date === "string" && Array.isArray(d.entries));
  const before = await Promise.all(valid.map((d) => getDay(d.date)));
  const now = Date.now();
  const changes = [];
  await tx("readwrite", (store) => {
    valid.forEach((day, i) => {
      const entries = day.entries.map((e) => ({ ...e, updatedAt: now }));
      store.put({ ...day, entries, invalidAt: now });
      const ids = new Set([...before[i].entries, ...entries].map((e) => e.id));
      for (const id of ids) changes.push({ kind: "entry", id, date: day.date, at: now });
      changes.push({ kind: "day", date: day.date, at: now });
    });
  });
  for (const c of changes) onChange(c);
}

// ---------- changes from sync ----------

// Insert or replace one entry, or remove it when entry is null.
export async function applyEntry(date, id, entry) {
  await mutateDay(date, (day) => {
    const rest = day.entries.filter((e) => e.id !== id);
    day.entries = entry ? [...rest, entry] : rest;
  });
}

export async function applyDayInvalid(date, invalid, at) {
  await mutateDay(date, (day) => setInvalid(day, invalid, at));
}
