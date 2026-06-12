// v1.268: native incoming-call notification via Notifee. Lifts the
// foreground-only IncomingCallOverlay into something that rings even
// when the app is killed (Android-only for now — iOS comes later with
// PushKit + CallKit native bridges).
//
// Flow:
//   1. Caller hits /call-ring on the worker.
//   2. Worker writes RTDB status="ringing" AND fires an Expo Push
//      data-only message to the recipient's uid: { type: "incoming-call",
//      callId, callerName, ... }.
//   3. Recipient's phone wakes the JS bundle via the Expo notifications
//      background task (see backgroundNotificationTask.ts).
//   4. That task calls displayIncomingCall() below, which renders a
//      Notifee notification with category="call" and a fullScreenAction
//      that takes over the lock screen exactly like a real phone call.
//   5. User taps Accept / Decline → the notification's actions fire
//      a Notifee event → handler in App.tsx writes the RTDB status and
//      navigates the foregrounded app to the Call screen.
//
// The notification channel is created lazily on the first display so
// we don't have to thread channel-creation into app cold start; channel
// creation is idempotent.

// v1.274 OTA-safety: @notifee/react-native is a NATIVE module added in
// the v1.268 build. Phones still on older binaries (iOS TestFlight
// build 14, Android v1.264 APK) don't have the native side — a static
// import here would crash the whole app at OTA-update launch, because
// index.ts imports this file (transitively) at startup. Lazy require +
// null guards turn "no native module" into "background ring silently
// unavailable", which is exactly the pre-v1.268 behavior those binaries
// had anyway. Same pattern CallScreen uses for the Daily.co SDK.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let notifeeMod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  notifeeMod = require("@notifee/react-native");
} catch {
  /* pre-v1.268 binary — no Notifee; call ring degrades to foreground-only */
}
const notifee = notifeeMod?.default ?? null;
const AndroidCategory = notifeeMod?.AndroidCategory ?? { CALL: "call" };
const AndroidImportance = notifeeMod?.AndroidImportance ?? { HIGH: 4 };
const AndroidVisibility = notifeeMod?.AndroidVisibility ?? { PUBLIC: 1 };

const CALL_CHANNEL_ID = "incoming-calls";

// Notification ID is deterministic per call so we can update / cancel
// the SAME notification when the caller hangs up or the call connects.
// Just the callId — Notifee tolerates arbitrary strings.
function callNotifId(callId: string): string {
  return `call:${callId}`;
}

// Lazy channel setup. Safe to call many times — Notifee no-ops if the
// channel already exists with these settings.
async function ensureCallChannel(): Promise<string> {
  if (!notifee) throw new Error("notifee unavailable in this binary");
  return notifee.createChannel({
    id: CALL_CHANNEL_ID,
    name: "Incoming calls",
    description: "Rings when a teammate calls you",
    importance: AndroidImportance.HIGH,
    sound: "default",
    vibration: true,
    vibrationPattern: [300, 500, 300, 500],
    // Bypass DND so calls ring through silent mode like a real phone call.
    bypassDnd: true,
    lights: true,
    lightColor: "#16a34a",
  });
}

export interface IncomingCallPayload {
  callId: string;
  callerName: string;
  callerUid?: string;
  roomUrl?: string;
}

// Show the ring. Called from the Expo background notification task on
// data-only push arrival, OR from the foreground listener as a fallback
// when the data message arrives while the app is open.
export async function displayIncomingCall(p: IncomingCallPayload): Promise<void> {
  if (!notifee) return; // pre-v1.268 binary — no native ring possible
  const channelId = await ensureCallChannel();

  await notifee.displayNotification({
    id: callNotifId(p.callId),
    title: "📞 Incoming call",
    body: `${p.callerName} is calling…`,
    data: {
      type: "incoming-call",
      callId: p.callId,
      callerName: p.callerName,
      callerUid: p.callerUid || "",
      roomUrl: p.roomUrl || "",
    },
    android: {
      channelId,
      // category=call promotes the notification to the top of the shade
      // and matches what the OS uses for native phone calls. Combined
      // with fullScreenAction below, locked-screen devices show a
      // full-screen ring UI instead of a heads-up banner.
      category: AndroidCategory.CALL,
      // colorized=true lets the green tint actually show on the lock
      // screen — Android only honors this for foreground services and
      // category=call notifications.
      colorized: true,
      color: "#16a34a",
      // High importance + showOnForeground makes the heads-up banner
      // appear even when the user is already in another app.
      importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PUBLIC,
      // ongoing=true prevents the user from swiping the notification
      // away without explicitly tapping Accept or Decline. Real phone
      // calls behave the same way.
      ongoing: true,
      // The smallIcon must be a drawable in the APK — Expo's bundled
      // ic_notification works (set up by expo-notifications plugin).
      smallIcon: "ic_notification",
      // Tapping the notification body (not the action buttons) opens
      // the app. The Notifee event listener in App.tsx interprets the
      // press based on the data payload.
      pressAction: {
        id: "default",
        launchActivity: "default",
      },
      // The full-screen intent triggers when the device is locked — the
      // notification expands to fill the screen, just like a phone call.
      // Requires USE_FULL_SCREEN_INTENT in the manifest (added in
      // v1.268).
      fullScreenAction: {
        id: "default",
        launchActivity: "default",
      },
      actions: [
        {
          title: "✓ Accept",
          pressAction: {
            id: "accept-call",
            launchActivity: "default",
          },
        },
        {
          title: "✕ Decline",
          pressAction: {
            id: "decline-call",
          },
        },
      ],
    },
  });
}

// Dismiss the call notification. Called when:
//   - The caller cancels before the recipient picks up.
//   - The recipient accepted (the in-call UI takes over).
//   - The call ended (either side).
//   - The 60s ring timeout elapses without a response.
export async function dismissIncomingCall(callId: string): Promise<void> {
  if (!notifee) return;
  try {
    await notifee.cancelNotification(callNotifId(callId));
  } catch {
    /* cancel is best-effort — notification may already be gone */
  }
}
