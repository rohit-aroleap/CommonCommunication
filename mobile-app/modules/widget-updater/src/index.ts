// TypeScript surface for the WidgetUpdater native module. Only Android
// is wired up today (iOS is a separate WidgetKit + App Groups effort —
// see widget/README.md). Calling setUnreadCounts on iOS is a silent
// no-op so the React layer doesn't need to platform-branch every call.

import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

// requireOptionalNativeModule returns null on platforms where the module
// isn't compiled in (i.e. iOS in our case). That lets the bundle still
// run on iOS — calls just become no-ops below.
const WidgetUpdater = requireOptionalNativeModule<{
  setUnreadCounts(chats: number, tickets: number, team: number): void;
}>("WidgetUpdater");

export function setWidgetUnreadCounts(
  chats: number,
  tickets: number,
  team: number,
): void {
  if (Platform.OS !== "android") return;
  if (!WidgetUpdater) return;
  try {
    // Clamp to non-negative integers — RN's bridge round-trip is happier
    // with ints and the widget code only checks count > 0 anyway.
    WidgetUpdater.setUnreadCounts(
      Math.max(0, Math.floor(chats)),
      Math.max(0, Math.floor(tickets)),
      Math.max(0, Math.floor(team)),
    );
  } catch {
    // Best-effort. If the native call fails (e.g. native module didn't
    // ship with this build because someone OTA'd over a pre-widget bundle),
    // the widget keeps its last-known state. Not worth crashing for.
  }
}
