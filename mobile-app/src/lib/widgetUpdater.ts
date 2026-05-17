// Thin JS wrapper over the WidgetUpdater Expo native module. The module
// itself only ships on Android — iOS is a separate WidgetKit + App Groups
// effort. Callers don't need to platform-branch; this helper no-ops on
// iOS and swallows errors if the native module didn't ship with the
// current binary (e.g. user is running an older APK that pre-dates the
// widget feature).
//
// Wire: useWidgetSync hook reads useAppData() unread counts and calls
// setWidgetUnreadCounts whenever they change. The native module persists
// them to SharedPreferences and broadcasts AppWidgetManager.ACTION_APPWIDGET_UPDATE,
// so the home-screen tiles redraw with fresh dot visibility within a second.

import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

interface WidgetUpdaterModule {
  setUnreadCounts(chats: number, tickets: number, team: number): void;
}

// requireOptionalNativeModule returns null when the native module isn't
// linked into the binary (iOS in our case, or pre-v1.139 Android builds).
// That keeps the JS bundle running rather than crashing on import.
const WidgetUpdater =
  requireOptionalNativeModule<WidgetUpdaterModule>("WidgetUpdater");

export function setWidgetUnreadCounts(
  chats: number,
  tickets: number,
  team: number,
): void {
  if (Platform.OS !== "android") return;
  if (!WidgetUpdater) return;
  try {
    // Clamp to non-negative integers — RN's bridge round-trip is happier
    // with ints, and the widget code only checks `count > 0` anyway.
    WidgetUpdater.setUnreadCounts(
      Math.max(0, Math.floor(chats)),
      Math.max(0, Math.floor(tickets)),
      Math.max(0, Math.floor(team)),
    );
  } catch {
    // Best-effort. If the native call fails we keep the widget's
    // last-known state — annoying but not worth crashing for.
  }
}
