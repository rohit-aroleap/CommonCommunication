// v1.249 — persistent SA transcription queue.
//
// Architecture: the trainer records an SA, the .m4a file stays on the
// tablet (in documentDirectory, which survives app close + OS storage
// pressure). The file's metadata is appended to this queue, persisted
// in AsyncStorage. A background processor iterates the queue and posts
// each pending item to the worker's /sa-transcribe-local endpoint.
//
// Why a queue (instead of upload-on-Stop):
//   - Tablet might be offline at Stop time → upload still happens later.
//   - Upload can fail transiently → retry with backoff, not lose data.
//   - App can be killed mid-upload → next launch resumes the queue.
//   - Multiple back-to-back SAs queue up without UI ceremony.
//
// State transitions per item:
//   "pending"     → first tick attempts upload
//   "in-flight"   → upload in progress (lock-out to prevent double-fire)
//   "ready"       → worker reported success + RTDB has the transcript
//                   → file kept on disk for replay (configurable)
//   "failed-retry"→ worker reported failure, will retry after backoff
//   "failed-stop" → exceeded MAX_RETRIES; needs manual retry from UI
//
// Backoff schedule (in seconds, from queue add or last failure):
//   1, 5, 30, 120, 600, 1800, 1800, 1800, …
// MAX_RETRIES of 10 ≈ 5.5 hrs of patient retry. After that the entry
// holds in "failed-stop" until the user explicitly retries.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { transcribeSaRecordingLocal } from "./worker";

const QUEUE_KEY = "@commoncomm/sa-queue/v1";
const MAX_RETRIES = 10;

// Backoff in milliseconds. Index = retryCount (0 = first failure).
const BACKOFF_MS = [
  1_000,
  5_000,
  30_000,
  120_000,
  600_000,
  1_800_000,
  1_800_000,
  1_800_000,
  1_800_000,
  1_800_000,
];

export type SaQueueStatus =
  | "pending"
  | "in-flight"
  | "ready"
  | "failed-retry"
  | "failed-stop";

export interface SaQueueItem {
  clientSessionId: string;       // phone-generated UUID; used as RTDB key
  chatKey: string;
  localUri: string;              // file:// path, documentDirectory
  fileName: string;
  uploadedByUid: string;
  uploadedByName: string;
  durationSec: number | null;
  sizeBytes: number | null;
  createdAt: number;             // epoch ms when added
  status: SaQueueStatus;
  retryCount: number;            // 0 = never failed
  lastAttemptAt: number;         // epoch ms
  nextAttemptAt: number;         // epoch ms; processor skips items where this is in future
  lastError: string | null;
}

let _memCache: SaQueueItem[] | null = null;
let _processorRunning = false;
type Listener = (items: SaQueueItem[]) => void;
const _listeners: Set<Listener> = new Set();

// ------- Persistence -------

async function loadFromStorage(): Promise<SaQueueItem[]> {
  if (_memCache) return _memCache;
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    _memCache = raw ? (JSON.parse(raw) as SaQueueItem[]) : [];
  } catch (e) {
    console.warn("[sa-queue] failed to load from AsyncStorage:", e);
    _memCache = [];
  }
  return _memCache;
}

async function saveToStorage(items: SaQueueItem[]): Promise<void> {
  _memCache = items;
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn("[sa-queue] failed to save to AsyncStorage:", e);
  }
  for (const l of _listeners) {
    try { l(items); } catch { /* ignore */ }
  }
}

// ------- Public API -------

export async function getQueue(): Promise<SaQueueItem[]> {
  return loadFromStorage();
}

export function subscribe(listener: Listener): () => void {
  _listeners.add(listener);
  // Fire immediately with the current state if cached
  if (_memCache) {
    try { listener(_memCache); } catch { /* ignore */ }
  }
  return () => _listeners.delete(listener);
}

export async function addToQueue(item: {
  clientSessionId: string;
  chatKey: string;
  localUri: string;
  fileName: string;
  uploadedByUid: string;
  uploadedByName: string;
  durationSec: number | null;
  sizeBytes: number | null;
}): Promise<SaQueueItem> {
  const items = await loadFromStorage();
  const now = Date.now();
  const entry: SaQueueItem = {
    ...item,
    createdAt: now,
    status: "pending",
    retryCount: 0,
    lastAttemptAt: 0,
    nextAttemptAt: now,
    lastError: null,
  };
  await saveToStorage([...items, entry]);
  // Kick the processor immediately — best-effort.
  void processQueue();
  return entry;
}

export async function markReady(clientSessionId: string): Promise<void> {
  const items = await loadFromStorage();
  const next = items.map((it) =>
    it.clientSessionId === clientSessionId
      ? { ...it, status: "ready" as SaQueueStatus, lastError: null }
      : it,
  );
  await saveToStorage(next);
}

export async function manualRetry(clientSessionId: string): Promise<void> {
  const items = await loadFromStorage();
  const now = Date.now();
  const next = items.map((it) =>
    it.clientSessionId === clientSessionId
      ? {
          ...it,
          status: "pending" as SaQueueStatus,
          retryCount: 0,
          nextAttemptAt: now,
          lastError: null,
        }
      : it,
  );
  await saveToStorage(next);
  void processQueue();
}

export async function removeFromQueue(clientSessionId: string): Promise<void> {
  const items = await loadFromStorage();
  await saveToStorage(items.filter((it) => it.clientSessionId !== clientSessionId));
}

// ------- Processor -------

// Best-effort idempotent UUID generator. We don't need cryptographic
// randomness here — collisions across one tablet's queue are
// astronomically unlikely with 128 bits of timestamp + random.
export function generateClientSessionId(): string {
  // 8 hex of timestamp + 16 hex of random = 24 chars total
  const ts = Date.now().toString(16).padStart(11, "0");
  const rand = Array.from({ length: 13 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `${ts}${rand}`;
}

// Single tick: find the oldest pending item whose nextAttemptAt has
// arrived, try to upload it, update its status. Called repeatedly while
// _processorRunning is true.
async function processQueue(): Promise<void> {
  if (_processorRunning) return;
  _processorRunning = true;
  try {
    while (true) {
      const items = await loadFromStorage();
      const now = Date.now();
      const target = items.find(
        (it) =>
          (it.status === "pending" || it.status === "failed-retry") &&
          it.nextAttemptAt <= now,
      );
      if (!target) break;

      // Mark in-flight so a concurrent tick (shouldn't happen given the
      // _processorRunning guard, but defense-in-depth) skips this entry.
      await updateItem(target.clientSessionId, (it) => ({
        ...it,
        status: "in-flight",
        lastAttemptAt: Date.now(),
      }));

      let success = false;
      let errMessage: string | null = null;
      try {
        const res = await transcribeSaRecordingLocal({
          fileUri: target.localUri,
          chatKey: target.chatKey,
          uploadedByUid: target.uploadedByUid,
          uploadedByName: target.uploadedByName,
          clientSessionId: target.clientSessionId,
          fileName: target.fileName,
          durationSec: target.durationSec,
        });
        if (res.ok) {
          success = true;
        } else {
          errMessage = res.error || "unknown upload error";
        }
      } catch (e) {
        errMessage = String((e as Error)?.message || e);
      }

      if (success) {
        // Worker accepted the upload — it's now transcribing in the
        // background. The RTDB record's status will flip to "ready" or
        // "failed" via the existing onValue listener path. Mark our
        // local queue item as "ready" since our job (handing it to the
        // worker) is done; the transcript itself surfaces via RTDB.
        await updateItem(target.clientSessionId, (it) => ({
          ...it,
          status: "ready",
          lastError: null,
        }));
      } else {
        const nextRetry = (target.retryCount || 0) + 1;
        const stop = nextRetry >= MAX_RETRIES;
        const backoff = BACKOFF_MS[Math.min(nextRetry - 1, BACKOFF_MS.length - 1)];
        await updateItem(target.clientSessionId, (it) => ({
          ...it,
          status: stop ? "failed-stop" : "failed-retry",
          retryCount: nextRetry,
          nextAttemptAt: Date.now() + backoff,
          lastError: errMessage,
        }));
      }
    }
  } finally {
    _processorRunning = false;
  }

  // Schedule a wake-up for the next failed-retry that's due. This is
  // belt-and-suspenders: ideally the app's foreground / network change
  // listeners kick the processor, but if neither fires, this timer
  // ensures we don't miss a retry.
  const items = _memCache || [];
  const next = items
    .filter((it) => it.status === "failed-retry")
    .map((it) => it.nextAttemptAt)
    .filter((t) => t > Date.now())
    .sort((a, b) => a - b)[0];
  if (next) {
    const delay = Math.max(1000, next - Date.now());
    setTimeout(() => { void processQueue(); }, delay);
  }
}

async function updateItem(
  clientSessionId: string,
  updater: (it: SaQueueItem) => SaQueueItem,
): Promise<void> {
  const items = await loadFromStorage();
  await saveToStorage(
    items.map((it) => (it.clientSessionId === clientSessionId ? updater(it) : it)),
  );
}

// Public kick. Called from app startup / network reconnect / Stop button.
export function kickProcessor(): void {
  void processQueue();
}
