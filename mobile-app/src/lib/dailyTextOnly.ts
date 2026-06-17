// v1.291: shared "Text only" toggle for the daily-workout group view.
// When on AND the Daily Groups filter is active, the chat list sorts by
// latest TEXT message and the open group's thread hides workout photos —
// turning the photo-flooded cohort groups into a normal "who texted a
// question" inbox. Module-level store + hook so ChatsScreen (list) and
// ThreadScreen (thread media filter) share one value. Persisted to
// AsyncStorage so the choice sticks across launches.

import { useEffect, useReducer } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "cc_dailyTextOnly";
let _value = false;
let _hydrated = false;
const _subs = new Set<() => void>();

// Hydrate once from AsyncStorage.
void AsyncStorage.getItem(KEY).then((v) => {
  _hydrated = true;
  if (v === "1" && !_value) {
    _value = true;
    for (const fn of _subs) fn();
  }
});

export function getDailyTextOnly(): boolean {
  return _value;
}

export function setDailyTextOnly(v: boolean): void {
  _value = !!v;
  void AsyncStorage.setItem(KEY, v ? "1" : "0");
  for (const fn of _subs) fn();
}

export function useDailyTextOnly(): [boolean, (v: boolean) => void] {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    _subs.add(force);
    // If hydration finished before this mounted with a true value, the
    // initial render already sees it; otherwise the hydrate callback
    // notifies. Nothing else to do.
    void _hydrated;
    return () => {
      _subs.delete(force);
    };
  }, []);
  return [_value, setDailyTextOnly];
}
