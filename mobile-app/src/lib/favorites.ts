// Pure helpers for the favorites/pin feature. The Chats screen pins
// favorites + chats with an open ticket assigned to me to the top of the
// list; auto-suggests a pin when the current user has been actively sending
// messages to a chat that isn't favorited yet.

import type { SendActivity } from "@/types";

export const SEND_SUGGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SEND_SUGGEST_MIN_COUNT = 3;

export function isRecentSendActivity(
  a: SendActivity | undefined,
  now: number = Date.now(),
): boolean {
  if (!a) return false;
  return now - (a.lastAt || 0) <= SEND_SUGGEST_WINDOW_MS;
}

export function shouldSuggestPin(
  chatKey: string,
  myFavorites: Record<string, boolean>,
  mySendActivity: Record<string, SendActivity>,
  now: number = Date.now(),
): boolean {
  if (myFavorites[chatKey]) return false;
  const a = mySendActivity[chatKey];
  if (!a) return false;
  if ((a.count || 0) < SEND_SUGGEST_MIN_COUNT) return false;
  return isRecentSendActivity(a, now);
}

// Given an existing record, return the next value after the current user
// sends a message. Resets the count when the previous activity is older
// than the suggest window — so the threshold reflects *recent* engagement,
// not lifetime sends.
export function nextSendActivity(
  prev: SendActivity | null | undefined,
  now: number = Date.now(),
): SendActivity {
  const within =
    prev && now - (prev.lastAt || 0) <= SEND_SUGGEST_WINDOW_MS;
  return {
    count: within ? (prev!.count || 0) + 1 : 1,
    lastAt: now,
  };
}
