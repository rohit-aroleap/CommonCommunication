// Firebase init with AsyncStorage-backed auth persistence so sign-ins survive
// app restarts. Uses the JS SDK (not @react-native-firebase) on purpose to
// stay on the Expo managed workflow — no native build prebuild required.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
// initializeAuth + getReactNativePersistence aren't exported from the public
// "firebase/auth" entry for some bundlers; pull them from the auth module
// directly via these typed thin wrappers.
import {
  initializeAuth,
  // @ts-expect-error: getReactNativePersistence is exported but not declared in types
  getReactNativePersistence,
} from "firebase/auth";
import { getStorage } from "firebase/storage";
import { FIREBASE_CONFIG } from "@/config";

export const firebaseApp = initializeApp(FIREBASE_CONFIG);

export const auth = initializeAuth(firebaseApp, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = getDatabase(firebaseApp);

// v1.174: Firebase Storage handle for internal-DM attachments. Customer-chat
// attachments still flow through worker → Periskope (Periskope hosts the
// bytes on Google Cloud Storage). DMs never round-trip through Periskope,
// so we upload the bytes ourselves to motherofdashboard's storage bucket
// and write the download URL into the message record alongside the other
// DM fields. See ThreadScreen.tsx onAttach / doSendDmMedia.
export const storage = getStorage(firebaseApp);
