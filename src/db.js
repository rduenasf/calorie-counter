// Tiny IndexedDB wrapper. One record per day, keyed by local date "YYYY-MM-DD":
// { date, invalid?: true, entries: [{ id, name, kcal, source: "manual" | "ai", note, thumb, createdAt }] }
// An invalid day keeps its entries but is left out of the weekly total and budget.

const DB_NAME = "calorie-counter";
const STORE = "days";

let dbPromise;

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

export async function setDayInvalid(date, invalid) {
  const day = await getDay(date);
  if (invalid) day.invalid = true;
  else delete day.invalid;
  await putDay(day);
}

export async function addEntry(date, entry) {
  const day = await getDay(date);
  day.entries.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...entry });
  await putDay(day);
  return day;
}

export async function updateEntry(date, id, patch) {
  const day = await getDay(date);
  day.entries = day.entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
  await putDay(day);
  return day;
}

export async function deleteEntry(date, id) {
  const day = await getDay(date);
  day.entries = day.entries.filter((e) => e.id !== id);
  await putDay(day);
  return day;
}

export async function allDays() {
  const db = await open();
  return wrap(db.transaction(STORE).objectStore(STORE).getAll());
}

export async function importDays(days) {
  await tx("readwrite", (store) => {
    for (const day of days) {
      if (day && typeof day.date === "string" && Array.isArray(day.entries)) store.put(day);
    }
  });
}
