// Per-user AsyncStorage snapshot cache. AppDataContext seeds React state from
// here on mount so the UI paints with last-known data instantly, instead of
// blocking 2-3s on the first Firebase round-trip. Live listeners then stream
// in and overwrite. Writes are debounced per-key so message storms don't
// trigger an AsyncStorage write on every snapshot.

import AsyncStorage from "@react-native-async-storage/async-storage";

// Bump if the cached shape becomes incompatible — old entries are then
// ignored on read (and overwritten on next listener payload).
const CACHE_VERSION = 1;

function cacheKey(uid: string, key: string): string {
  return `cc:cache:v${CACHE_VERSION}:${uid}:${key}`;
}

export async function cacheGet<T>(uid: string, key: string): Promise<T | null> {
  if (!uid) return null;
  try {
    const raw = await AsyncStorage.getItem(cacheKey(uid, key));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Debounce per (uid, key) so a rapid burst of snapshots only triggers one
// write. 1s is long enough to coalesce a chat-list update with the dozen
// /chats child writes that typically follow a message, short enough that a
// kill-the-app-immediately user still gets the latest snapshot persisted.
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, unknown>();

export function cacheSet<T>(uid: string, key: string, value: T): void {
  if (!uid) return;
  const k = cacheKey(uid, key);
  pendingValues.set(k, value);
  const existing = pendingTimers.get(k);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    const v = pendingValues.get(k);
    pendingTimers.delete(k);
    pendingValues.delete(k);
    AsyncStorage.setItem(k, JSON.stringify(v)).catch(() => {});
  }, 1000);
  pendingTimers.set(k, t);
}

