// Expo push token registration. Called once on successful sign-in. We send
// the token to the Worker which stashes it at commonComm/pushTokens/{uid}/*
// so /webhook can fan out to every signed-in agent on inbound messages.

import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { registerPushToken } from "@/lib/worker";

// Foreground display: show banner + play sound when a push arrives while
// the user is already inside the app. Matches WhatsApp's behaviour.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // shouldShowAlert is deprecated in SDK 53+; replaced by the two specific
    // shouldShow* fields below. Keep both for back-compat across SDK levels.
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPushAsync(uid: string): Promise<string | null> {
  if (!Device.isDevice) {
    // Simulators / emulators don't have a push entitlement.
    return null;
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== "granted") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#008069",
    });
  }

  const projectId =
    (Constants?.expoConfig as any)?.extra?.eas?.projectId ??
    (Constants as any)?.easConfig?.projectId;

  let tokenResp;
  try {
    tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
  } catch (e) {
    console.warn("[push] getExpoPushTokenAsync failed:", e);
    return null;
  }
  const token = tokenResp.data;
  if (!token) return null;

  await registerPushToken(uid, token, Platform.OS === "ios" ? "ios" : "android");
  return token;
}
