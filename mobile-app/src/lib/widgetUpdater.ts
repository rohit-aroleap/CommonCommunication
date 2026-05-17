// Thin JS wrapper over the WidgetUpdater Expo native module. Available
// on both Android (v1.139) and iOS (v1.140). Callers don't need to
// platform-branch; this helper picks the right native implementation
// at runtime and silently swallows errors if the module didn't ship
// with the current binary (e.g. user is on an older APK / TestFlight
// build that pre-dates widget support).
//
// Wire: useWidgetSync hook reads useAppData() unread counts and calls
// setWidgetUnreadCounts whenever they change. The Android module
// persists counts to SharedPreferences and broadcasts an
// ACTION_APPWIDGET_UPDATE; the iOS module persists to an App Group
// UserDefaults suite and calls WidgetCenter.shared.reloadAllTimelines().
// Either way the home-screen widget redraws with fresh dot visibility
// within a second.

import { requireOptionalNativeModule } from "expo-modules-core";

interface WidgetUpdaterModule {
  setUnreadCounts(chats: number, tickets: number, team: number): void;
}

// requireOptionalNativeModule returns null when the native module isn't
// linked into the binary (older builds, or platforms the module config
// excluded). That keeps the JS bundle running rather than crashing on
// import.
const WidgetUpdater =
  requireOptionalNativeModule<WidgetUpdaterModule>("WidgetUpdater");

export function setWidgetUnreadCounts(
  chats: number,
  tickets: number,
  team: number,
): void {
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
