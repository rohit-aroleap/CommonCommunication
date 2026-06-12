// v1.274: daily-workout cohort groups. Wrappers over the worker's
// /cohort-list and /cohort-add endpoints, which proxy the cohort
// registry that the Achievement-analysis dashboard maintains at
// 90sLab/workout-calendar/* in the shared Firebase. Trainers add
// customers (plus everyone on the same subscription) to a cohort's
// WhatsApp group straight from the phone.

import { useEffect, useReducer } from "react";
import { WORKER_URL } from "@/config";

export interface CohortMember {
  phone: string;
  name: string;
}

export interface Cohort {
  code: string; // e.g. "C038"
  chatId: string; // WhatsApp group id ...@g.us
  members: CohortMember[];
}

export interface CohortList {
  cohorts: Cohort[];
  // last-10-digit phone keys of every member across all cohorts —
  // powers the "not in any cohort yet" badge without re-walking
  // every member list per chat row.
  assignedPhoneKeys: Set<string>;
}

// Same convention the worker / AA dashboard use: last 10 digits.
export function cohortPhoneKey(phone: string | null | undefined): string {
  return String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);
}

export async function fetchCohortList(): Promise<CohortList | null> {
  try {
    const res = await fetch(`${WORKER_URL}/cohort-list`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.ok) return null;
    return {
      cohorts: Array.isArray(j.cohorts) ? j.cohorts : [],
      assignedPhoneKeys: new Set<string>(
        Array.isArray(j.assignedPhoneKeys) ? j.assignedPhoneKeys : [],
      ),
    };
  } catch {
    return null;
  }
}

export async function cohortAdd(body: {
  cohortCode: string;
  members: CohortMember[];
  byUid: string;
  byName: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${WORKER_URL}/cohort-add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) {
      return {
        ok: false,
        error: j?.detail || j?.error || `HTTP ${res.status}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// Which cohort (if any) is this phone already in? Returns the cohort
// code or null. Linear scan — cohort count is small (dozens).
export function findCohortForPhone(
  cohorts: Cohort[],
  phone: string,
): string | null {
  const key = cohortPhoneKey(phone);
  if (!key) return null;
  for (const c of cohorts) {
    for (const m of c.members) {
      if (cohortPhoneKey(m.phone) === key) return c.code;
    }
  }
  return null;
}

// Default pick for the cohort selector: the group with the FEWEST
// active members — matches the Achievement-analysis dashboard's
// "C038 · 0 active" behavior, so new customers spread across groups
// instead of piling into one. activeStatusByPhoneKey maps last-10
// phone keys → true for customers whose Ferra subscription is ACTIVE.
export function pickDefaultCohort(
  cohorts: Cohort[],
  isActivePhoneKey: (key: string) => boolean,
): Cohort | null {
  if (!cohorts.length) return null;
  let best: Cohort | null = null;
  let bestCount = Infinity;
  for (const c of cohorts) {
    let active = 0;
    for (const m of c.members) {
      if (isActivePhoneKey(cohortPhoneKey(m.phone))) active++;
    }
    if (active < bestCount) {
      bestCount = active;
      best = c;
    }
  }
  return best;
}

// Active-member count for display in the picker ("C038 · 3 active").
export function cohortActiveCount(
  cohort: Cohort,
  isActivePhoneKey: (key: string) => boolean,
): number {
  let n = 0;
  for (const m of cohort.members) {
    if (isActivePhoneKey(cohortPhoneKey(m.phone))) n++;
  }
  return n;
}

// ── Shared cohort cache + hook ──────────────────────────────────────
// Module-level cache so ChatsScreen (badge) and CustomerInfoScreen
// (picker) share one fetch instead of each hammering /cohort-list.
// Stale after 5 minutes; refreshCohorts() forces a re-fetch (called
// after every successful add so the UI reflects the new membership
// immediately).
let _cache: CohortList | null = null;
let _fetchedAt = 0;
let _inflight: Promise<void> | null = null;
const _subscribers = new Set<() => void>();
const CACHE_TTL_MS = 5 * 60_000;

export async function refreshCohorts(): Promise<void> {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const data = await fetchCohortList();
    if (data) {
      _cache = data;
      _fetchedAt = Date.now();
      for (const fn of _subscribers) fn();
    }
    _inflight = null;
  })();
  return _inflight;
}

export function useCohorts(): {
  cohorts: Cohort[];
  assignedPhoneKeys: Set<string>;
  loaded: boolean;
} {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    _subscribers.add(force);
    if (!_cache || Date.now() - _fetchedAt > CACHE_TTL_MS) {
      void refreshCohorts();
    }
    return () => {
      _subscribers.delete(force);
    };
  }, []);
  return {
    cohorts: _cache?.cohorts ?? [],
    assignedPhoneKeys: _cache?.assignedPhoneKeys ?? new Set(),
    loaded: !!_cache,
  };
}
