// v1.268: Expo background notification task. Fires when an Expo Push
// data-only message arrives while the app is in the background OR
// killed entirely — the OS spins up a tiny JS runtime, executes this
// task, then tears it down. This is what wakes the phone for an
// incoming call when the app isn't open.
//
// IMPORTANT: This file is imported from index.ts at module-load time
// (NOT inside App.tsx) so the task is registered before the JS engine
// has a chance to start the React app. If you move the import into a
// component, push delivery in killed state will silently fail because
// the task name won't be registered when the OS tries to dispatch it.
//
// The task only handles `type: "incoming-call"` data messages. Other
// notification types (chat pushes, mention pings, etc.) go through
// expo-notifications' default foreground/tap handling — no special
// background path needed.

import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import { displayIncomingCall, dismissIncomingCall } from "./incomingCall";

// Expo's reserved task name for background notification handling. The
// platform looks up this exact string when dispatching a data message
// to a killed app, so DON'T change it — it's the value defined by
// expo-notifications, not one we made up.
const BACKGROUND_NOTIFICATION_TASK = "EXPO_BACKGROUND_NOTIFICATION_TASK";

TaskManager.defineTask(
  BACKGROUND_NOTIFICATION_TASK,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ data, error }: { data: any; error: unknown }) => {
    if (error) {
      console.warn("[bg-notif-task] error:", error);
      return;
    }
    if (!data) return;
    // Expo wraps the data payload differently depending on whether the
    // notification was a data-only push (data.notification) or a
    // standard push with a body (data). Cover both shapes — the data
    // we want to extract sits in one of these.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any = null;
    if (data?.notification?.data) {
      payload = data.notification.data;
    } else if (data?.data) {
      payload = data.data;
    } else {
      payload = data;
    }
    if (!payload) return;
    const callId = String(payload.callId || "");
    if (!callId) return;

    // v1.268: cancel-call — caller hung up or call timed out before
    // the recipient picked up. Dismiss the ringing notification so
    // the phone stops ringing.
    if (payload.type === "cancel-call") {
      try {
        await dismissIncomingCall(callId);
      } catch (e) {
        console.warn("[bg-notif-task] dismissIncomingCall failed:", e);
      }
      return;
    }

    if (payload.type !== "incoming-call") return;

    const callerName = String(payload.callerName || "Unknown caller");
    const callerUid = payload.callerUid
      ? String(payload.callerUid)
      : undefined;
    const roomUrl = payload.roomUrl ? String(payload.roomUrl) : undefined;

    try {
      await displayIncomingCall({ callId, callerName, callerUid, roomUrl });
    } catch (e) {
      console.warn("[bg-notif-task] displayIncomingCall failed:", e);
    }
  },
);

// Register the task so the OS routes background notifications to it.
// Idempotent: calling this again is a no-op if the task is already
// registered, so it's safe to run on every cold start.
//
// Awaited lazily on first sign-in — we don't want the task active
// pre-login because then we'd ring on calls intended for whichever
// user was last signed in.
let registered = false;
export async function registerBackgroundNotificationTaskAsync(): Promise<void> {
  if (registered) return;
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
    registered = true;
  } catch (e) {
    console.warn("[bg-notif-task] registerTaskAsync failed:", e);
  }
}

// Unregister on sign-out so a logged-out device doesn't ring for the
// previous user's calls. The token unregistration in /push-token cleanup
// is the primary defense; this is belt-and-suspenders.
export async function unregisterBackgroundNotificationTaskAsync(): Promise<void> {
  if (!registered) return;
  try {
    await Notifications.unregisterTaskAsync(BACKGROUND_NOTIFICATION_TASK);
    registered = false;
  } catch (e) {
    console.warn("[bg-notif-task] unregisterTaskAsync failed:", e);
  }
}
