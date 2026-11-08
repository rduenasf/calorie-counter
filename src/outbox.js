// Local changes waiting to be pushed, kept in localStorage so they survive a reload,
// being offline, or being signed out. Only keys and times are stored: the push reads
// the current value from IndexedDB, and an entry that's gone by then was deleted.
// Shape: { entries: { [id]: { date, at } }, days: { [date]: at } }

const KEY = "syncOutbox";

export function loadOutbox() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY));
    if (o && o.entries && o.days) return o;
  } catch {}
  return { entries: {}, days: {} };
}

function save(o) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {}
}

export function recordChange(c) {
  const o = loadOutbox();
  if (c.kind === "entry") o.entries[c.id] = { date: c.date, at: c.at };
  else o.days[c.date] = c.at;
  save(o);
}

// Drop items that were pushed (or lost to a newer remote change), unless they
// changed again since: a newer time means there's a newer change still to push.
// Both maps go from key to the `at` time that was handled.
export function clearFromOutbox({ entries = {}, days = {} }) {
  const o = loadOutbox();
  for (const [id, at] of Object.entries(entries)) if (o.entries[id]?.at === at) delete o.entries[id];
  for (const [date, at] of Object.entries(days)) if (o.days[date] === at) delete o.days[date];
  save(o);
}
