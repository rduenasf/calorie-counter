// Firestore sync. IndexedDB stays the app's source of truth; this module mirrors it to
//   users/{uid}/entries/{id}   { date, name, kcal, source, note, thumb?, createdAt, updatedAt, deleted, syncedAt }
//   users/{uid}/days/{date}    { invalid, updatedAt, syncedAt }
// Deleted entries stay as small tombstones ({ date, deleted: true, updatedAt }) so the
// delete reaches devices that were offline. For each entry or day, the newer updatedAt wins.
//
// Reads stay small: the first sign-in on a device reads everything once and merges it
// with what's here; after that the listener only asks for docs whose server-set
// syncedAt is newer than the last one this device saw.
//
// Loaded with a dynamic import so the Firebase SDK is only fetched when it's configured.

import { initializeApp } from "firebase/app";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut as fbSignOut,
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, getDocsFromServer, onSnapshot, query, where, serverTimestamp, Timestamp,
} from "firebase/firestore";
import { allDays, getDay, applyEntry, applyDayInvalid } from "./db.js";
import { loadOutbox, recordChange, clearFromOutbox } from "./outbox.js";
import { firebaseConfig } from "./firebase-config.js";

// Re-read this much before the last seen syncedAt, in case two commits land out of order.
const OVERLAP_MS = 60_000;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// The persistent cache also queues writes made offline and sends them later, even after a reload.
const fs = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  ignoreUndefinedProperties: true,
});

let user = null;
let ready = false; // the first-sign-in merge is done for this user
let unsubs = [];
let onRemoteChange = () => {};
let onStatus = () => {};
let status = { user: null, state: "signed-out", error: "" };

function setStatus(patch) {
  status = { ...status, ...patch };
  onStatus(status);
}

const seenKey = (uid) => `syncSeen:${uid}`;
const getSeen = (uid) => {
  const v = localStorage.getItem(seenKey(uid));
  return v === null ? null : Number(v);
};
const setSeen = (uid, ms) => localStorage.setItem(seenKey(uid), String(Math.floor(ms)));

const entriesCol = () => collection(fs, "users", user.uid, "entries");
const daysCol = () => collection(fs, "users", user.uid, "days");

function fail(err) {
  console.error("Sync:", err);
  setStatus({ state: "error", error: err?.code === "permission-denied" ? "Permission denied: check the Firestore rules." : String(err?.message ?? err) });
}

// ---------- push ----------

async function findLocalEntry(date, id) {
  return (await getDay(date)).entries.find((e) => e.id === id) ?? null;
}

function entryDoc(date, local, at) {
  if (!local) return { date, deleted: true, updatedAt: at, syncedAt: serverTimestamp() };
  const { id, ...fields } = local;
  return { ...fields, date, updatedAt: local.updatedAt ?? local.createdAt ?? at, deleted: false, syncedAt: serverTimestamp() };
}

let flushing = null;
let flushAgain = false;

// Writes go to the local Firestore cache right away and reach the server when online,
// so there's no waiting on the network here. setDoc's promise settles on the server's answer.
async function flushNow() {
  if (!user || !ready) return;
  const o = loadOutbox();
  const done = { entries: {}, days: {} };
  for (const [id, { date, at }] of Object.entries(o.entries)) {
    const local = await findLocalEntry(date, id);
    setDoc(doc(entriesCol(), id), entryDoc(date, local, at)).catch(fail);
    done.entries[id] = at;
  }
  for (const [date, at] of Object.entries(o.days)) {
    const day = await getDay(date);
    setDoc(doc(daysCol(), date), { invalid: !!day.invalid, updatedAt: day.invalidAt ?? at, syncedAt: serverTimestamp() }).catch(fail);
    done.days[date] = at;
  }
  clearFromOutbox(done);
}

export function flush() {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = flushNow()
    .catch(fail)
    .finally(() => {
      flushing = null;
      if (flushAgain) {
        flushAgain = false;
        flush();
      }
    });
  return flushing;
}

// ---------- pull ----------

// Apply one remote entry if it's at least as new as what's here. Returns true when local data changed.
async function applyRemoteEntry(id, data) {
  if (typeof data.date !== "string") return false;
  const local = await findLocalEntry(data.date, id);
  const pending = loadOutbox().entries[id];
  const localAt = Math.max(local?.updatedAt ?? local?.createdAt ?? 0, pending?.at ?? 0);
  const remoteAt = data.updatedAt ?? 0;
  if (remoteAt < localAt) return false;
  if (pending) clearFromOutbox({ entries: { [id]: pending.at } }); // the remote change is newer
  if (data.deleted) {
    if (!local) return false;
    await applyEntry(data.date, id, null);
    return true;
  }
  const { date, deleted, syncedAt, ...fields } = data;
  await applyEntry(date, id, { id, ...fields });
  return true;
}

async function applyRemoteDay(date, data) {
  const local = await getDay(date);
  const pending = loadOutbox().days[date];
  const localAt = Math.max(local.invalidAt ?? 0, pending ?? 0);
  if ((data.updatedAt ?? 0) < localAt) return false;
  if (pending) clearFromOutbox({ days: { [date]: pending } });
  if (!!local.invalid === !!data.invalid) return false;
  await applyDayInvalid(date, !!data.invalid, data.updatedAt ?? 0);
  return true;
}

const millis = (ts) => (ts instanceof Timestamp ? ts.toMillis() : 0);

// First sign-in on this device: read everything, take what's newer remotely, and queue
// what's newer (or only) here. Entries here that never synced end up in the account.
async function fullMerge(uid) {
  // From the server, not the cache: an offline merge would see an empty or stale account.
  const [entrySnap, daySnap] = await Promise.all([getDocsFromServer(entriesCol()), getDocsFromServer(daysCol())]);
  let seen = 0;
  let changed = false;
  const remoteEntries = new Map();
  const remoteDays = new Map();

  for (const d of entrySnap.docs) {
    const data = d.data();
    remoteEntries.set(d.id, data);
    seen = Math.max(seen, millis(data.syncedAt));
    if (await applyRemoteEntry(d.id, data)) changed = true;
  }
  for (const d of daySnap.docs) {
    const data = d.data();
    remoteDays.set(d.id, data);
    seen = Math.max(seen, millis(data.syncedAt));
    if (await applyRemoteDay(d.id, data)) changed = true;
  }

  // Queue local data the account doesn't have yet, or has an older version of.
  for (const day of await allDays()) {
    for (const e of day.entries) {
      const at = e.updatedAt ?? e.createdAt ?? 0;
      const r = remoteEntries.get(e.id);
      if (!r || (r.updatedAt ?? 0) < at) recordChange({ kind: "entry", id: e.id, date: day.date, at });
    }
    const r = remoteDays.get(day.date);
    const at = day.invalidAt ?? 0;
    if (r ? (r.updatedAt ?? 0) < at : day.invalid) recordChange({ kind: "day", date: day.date, at });
  }

  setSeen(uid, seen);
  return changed;
}

function listen(uid) {
  const since = Timestamp.fromMillis(Math.max(0, (getSeen(uid) ?? 0) - OVERLAP_MS));
  // Snapshots are handled one at a time, in order, across both listeners.
  let queue = Promise.resolve();
  const handle = async (snap, apply) => {
    let changed = false;
    let seen = 0;
    for (const ch of snap.docChanges()) {
      // Our own writes come back once the server has stamped them; skip the local echo.
      if (ch.type === "removed" || ch.doc.metadata.hasPendingWrites) continue;
      const data = ch.doc.data();
      seen = Math.max(seen, millis(data.syncedAt));
      if (await apply(ch.doc.id, data)) changed = true;
    }
    if (user?.uid !== uid) return;
    setSeen(uid, Math.max(getSeen(uid) ?? 0, seen));
    setStatus({ state: snap.metadata.fromCache ? "offline" : "synced", error: "" });
    if (changed) onRemoteChange();
  };
  const watch = (col, apply) =>
    onSnapshot(
      query(col, where("syncedAt", ">", since)),
      { includeMetadataChanges: true }, // so the status flips between offline and synced
      (snap) => (queue = queue.then(() => handle(snap, apply)).catch(fail)),
      fail
    );
  unsubs = [watch(entriesCol(), applyRemoteEntry), watch(daysCol(), applyRemoteDay)];
}

async function start(u) {
  user = u;
  ready = false;
  setStatus({ user: u.email || u.displayName || "your account", state: "syncing", error: "" });
  try {
    if (getSeen(u.uid) === null && (await fullMerge(u.uid))) onRemoteChange();
  } catch (err) {
    if (user !== u) return;
    // The first merge needs the server. Try again once the device is back online.
    if (err?.code === "unavailable" || !navigator.onLine) {
      setStatus({ state: "offline", error: "" });
      window.addEventListener("online", () => user === u && start(u), { once: true });
    } else {
      fail(err);
    }
    return;
  }
  if (user !== u) return; // signed out meanwhile
  ready = true;
  flush();
  listen(u.uid);
}

function stop() {
  for (const u of unsubs) u();
  unsubs = [];
  user = null;
  ready = false;
  setStatus({ user: null, state: "signed-out", error: "" });
}

// ---------- public ----------

export function initSync(handlers) {
  onRemoteChange = handlers.onRemoteChange ?? onRemoteChange;
  onStatus = handlers.onStatus ?? onStatus;
  onStatus(status);
  onAuthStateChanged(auth, (u) => {
    if (u?.uid === user?.uid) return;
    stop();
    if (u) start(u);
  });
}

export async function signIn() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    // Some installed-app contexts block popups; a full-page redirect works there.
    if (err?.code === "auth/popup-blocked" || err?.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (err?.code !== "auth/popup-closed-by-user" && err?.code !== "auth/cancelled-popup-request") {
      throw err;
    }
  }
}

// Local data stays on the device. Signing in again merges it with the account from scratch.
export async function signOut() {
  const uid = user?.uid;
  stop();
  await fbSignOut(auth);
  if (uid) localStorage.removeItem(seenKey(uid));
}
