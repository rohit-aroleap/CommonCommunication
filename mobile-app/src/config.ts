// Constants ported verbatim from index.html / mobile.html so client logic
// stays in lockstep with the desktop dashboard. Anything that affects what
// users see (display-name resolution, filter buckets, daily-group prefix)
// must match across all surfaces — see resolveDisplayName, isDailyGroup,
// FERRA_TAG_STAGE in index.html for the source of truth.

import Constants from "expo-constants";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC5mZAG98VAeDpp1IssYYQ2kcKeClyqIGc",
  authDomain: "motherofdashboard.firebaseapp.com",
  databaseURL:
    "https://motherofdashboard-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "motherofdashboard",
  storageBucket: "motherofdashboard.firebasestorage.app",
  messagingSenderId: "1014194001329",
  appId: "1:1014194001329:web:ca49a6a081d42575d2d990",
};

const extra = (Constants.expoConfig?.extra ?? {}) as {
  workerUrl?: string;
  googleSignIn?: {
    iosClientId?: string;
    androidClientId?: string;
    webClientId?: string;
  };
};

export const WORKER_URL =
  extra.workerUrl ??
  "https://common-communication.rohitpatel-mailid297.workers.dev";

export const GOOGLE_OAUTH = {
  iosClientId: extra.googleSignIn?.iosClientId ?? "",
  androidClientId: extra.googleSignIn?.androidClientId ?? "",
  webClientId: extra.googleSignIn?.webClientId ?? "",
};

export const ROOT = "commonComm";

export const BOOTSTRAP_ADMINS = [
  "rohit@aroleap.com",
  "rohitpatel.mailid297@gmail.com",
];

export const DAILY_GROUP_PREFIX = "Daily Workout Ferra C";

export const FERRA_TAG_STAGE: Record<string, string> = {
  "Order Pending": "setup",
  "Auto Pay Pending": "setup",
  "Approval Pending": "setup",
  "Machine Assign Pending": "setup",
  "Installation Pending": "setup",
  "Persona Call Pending": "onboarding",
  "Exercises Call Pending": "onboarding",
  "Hand Off Pending": "onboarding",
  "SA Reach Out Pending": "sa",
  "SA Follow Up": "sa",
  "All Steps Complete": "active",
  "All Done": "active",
  "Uninstallation Pending": "offboarding",
  "Pickup Pending": "offboarding",
  "Received in Warehouse": "offboarding",
};

export const STAGE_LABELS: Record<string, string> = {
  setup: "Setup",
  onboarding: "Onboarding",
  sa: "SA",
  active: "Active",
  offboarding: "Offboarding",
};

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB
