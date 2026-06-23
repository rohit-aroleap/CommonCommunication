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

export const BOOTSTRAP_ADMINS = ["rohit@aroleap.com"];

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
  // v1.222: "All Done" moved from "active" → "offboarding". Originally
  // grouped with Active because the tag implied "everything wrapped up",
  // but in Ferra's data it actually flags customers winding down their
  // engagement — they're done with the program, not actively using it.
  // Belongs alongside Uninstallation / Pickup / Warehouse on the
  // offboarding ramp. Must stay in lockstep with FERRA_TAG_STAGE in
  // index.html — the comment at the top of this file flags this pair
  // as a single source of truth.
  "All Done": "offboarding",
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

// v1.223: team-tag membership system. Mirrors TEAM_TAGS + FERRA_TAG_TEAMS
// in index.html — the comment at the top of this file flags these as a
// single source of truth pair (must update both, in lockstep). Trainers
// with a `teams` array set on their teamMembers record see ONLY customers
// whose Ferra tag belongs to one of those teams, plus anyone with a
// ticket assigned to them. Empty / missing `teams` = full visibility
// (back-compat — existing trainers keep working with no change).
export const TEAM_TAGS: Record<string, string> = {
  installation: "Installation",
  onboarding: "Onboarding",
  sa: "Strength Assessment",
  retention: "Retention",
  sales: "Sales",
};
export const FERRA_TAG_TEAMS: Record<string, string[]> = {
  "Order Pending":           ["sales"],
  "Auto Pay Pending":        ["sales"],
  "Approval Pending":        ["sales"],
  "Machine Assign Pending":  ["installation"],
  "Installation Pending":    ["installation"],
  "Persona Call Pending":    ["onboarding"],
  "Exercises Call Pending":  ["onboarding"],
  "Hand Off Pending":        ["onboarding"],
  "SA Reach Out Pending":    ["sa"],
  "SA Follow Up":            ["sa"],
  "All Steps Complete":      ["retention"],
  "All Done":                ["retention"],
  "Uninstallation Pending":  ["retention"],
  "Pickup Pending":          ["retention"],
  "Received in Warehouse":   ["retention"],
};

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50 MB
