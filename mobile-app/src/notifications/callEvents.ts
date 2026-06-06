// v1.268: Notifee event plumbing for the incoming-call notification.
//
// The notification has three interactive points:
//   - Body tap         → open the app, recipient sees the in-app accept UI
//                        (or auto-accepts via deep-link in a future iter)
//   - Accept action    → write RTDB status="accepted" + nav to Call screen
//   - Decline action   → write RTDB status="declined" + dismiss
//
// Notifee fires events in three contexts we have to cover:
//   1. Foreground — onForegroundEvent fires while the app is open. We
//      wire navigation here.
//   2. Background — onBackgroundEvent fires when the app is in the bg
//      or killed and the user taps an action. Notifee spins up a tiny
//      JS context for this. NO navigation possible here (no React tree
//      mounted); we update RTDB and stash the pending callId so the
//      next app cold-start picks it up.
//   3. Initial notification — getInitialNotification() returns the
//      notification that LAUNCHED the app. Called once after the
//      navigator is ready, then it consumes (doesn't re-fire on
//      subsequent foregrounds).

import notifee, {
  EventType,
  type Event,
} from "@notifee/react-native";
import { dismissIncomingCall } from "./incomingCall";
import { updateCallStatus } from "@/lib/calls";

// Set by the foreground listener once a navigation ref is plugged in.
// We can't import React Navigation's NavigationContainer ref directly
// here without creating a circular module dep, so the App-side mount
// passes us the navigate function.
type NavigateFn = (callId: string) => void;
let navigateToCallFn: NavigateFn | null = null;

export function setCallNavigator(fn: NavigateFn | null): void {
  navigateToCallFn = fn;
}

// Pending action observed in the background — picked up by the
// foreground listener / initial-notification check on next app open.
// Stored in module state because Notifee's background context is
// short-lived and can't directly drive navigation.
interface PendingCallAction {
  callId: string;
  action: "accept" | "decline" | "open";
  at: number;
}
let pendingCallAction: PendingCallAction | null = null;

export function takePendingCallAction(): PendingCallAction | null {
  const out = pendingCallAction;
  pendingCallAction = null;
  return out;
}

// Single shared handler for both foreground and background events.
// `inForeground` controls whether we're allowed to navigate (we can't
// navigate from the bg context — React tree isn't mounted).
async function handleEvent(
  event: Event,
  inForeground: boolean,
): Promise<void> {
  const { type, detail } = event;
  if (type !== EventType.ACTION_PRESS && type !== EventType.PRESS) return;
  const notification = detail.notification;
  const pressAction = detail.pressAction;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (notification?.data || {}) as any;
  if (data.type !== "incoming-call") return;
  const callId = String(data.callId || "");
  if (!callId) return;

  // Decline action — fires whether we're foreground or background.
  if (pressAction?.id === "decline-call") {
    void updateCallStatus(callId, "declined");
    await dismissIncomingCall(callId);
    return;
  }

  // Accept action OR body tap. Both mean "I want to take this call".
  // In foreground we can navigate immediately; in bg we stash the
  // callId and let the next foreground cycle pick it up.
  const isAccept = pressAction?.id === "accept-call";
  const action: "accept" | "open" = isAccept ? "accept" : "open";

  if (isAccept) {
    void updateCallStatus(callId, "accepted");
  }
  // Dismiss the call notification — once we're navigating to the
  // in-call screen, the ring should stop.
  await dismissIncomingCall(callId);

  if (inForeground && navigateToCallFn) {
    navigateToCallFn(callId);
  } else {
    pendingCallAction = { callId, action, at: Date.now() };
  }
}

// Register both listeners. Foreground is wired from App.tsx after the
// navigator mounts; background is set up at module load (similar to
// the Expo task) so it's ready before the React tree exists.
export function registerForegroundCallEventListener(): () => void {
  return notifee.onForegroundEvent((event) => {
    void handleEvent(event, true);
  });
}

// Background event handler. Notifee REQUIRES this to be set at module
// scope (not inside a component) so it survives the app being killed.
notifee.onBackgroundEvent(async (event) => {
  await handleEvent(event, false);
});

// Probe for a notification that LAUNCHED the app from cold-start. Call
// once after the navigator is ready. Consumes the result.
export async function consumeInitialCallNotification(): Promise<{
  callId: string;
} | null> {
  try {
    const initial = await notifee.getInitialNotification();
    if (!initial) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (initial.notification?.data || {}) as any;
    if (data.type !== "incoming-call") return null;
    const callId = String(data.callId || "");
    if (!callId) return null;
    const isAccept = initial.pressAction?.id === "accept-call";
    if (isAccept) {
      void updateCallStatus(callId, "accepted");
    }
    void dismissIncomingCall(callId);
    return { callId };
  } catch (e) {
    console.warn("[call-events] getInitialNotification failed:", e);
    return null;
  }
}
