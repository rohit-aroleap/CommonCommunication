import Constants from "expo-constants";
import * as Updates from "expo-updates";

// MANUALLY BUMP THIS WITH EVERY EAS UPDATE.
//
// Match the web dashboard's version (index.html <title> + APP_VERSION) so
// trainers can tell at a glance whether the laptop dashboard and the phone
// app are on the same release. The OTA update ID is also shown alongside as
// a debug suffix, but it's the kind of hex hash humans can't compare — this
// constant is the friendly version label.
//
// Bump in lockstep with index.html's "v1.xxx" strings on every commit that
// touches user-visible behavior.
export const APP_VERSION = "v1.145";

// Source of truth for the user-visible version string.
//
// Format: "v1.144 · OTA abc12345" — first part is the manually-bumped
// APP_VERSION (human-comparable, matches the web dashboard); second part is
// the OTA bundle hash (debug aid for when we need to verify which exact JS
// bundle is running on a phone). If the app is on the bundle that shipped
// inside the binary (no OTA applied yet), the suffix is "(embedded)".
//
// The native binary version (app.config.js `version`, e.g. "0.1.0") is no
// longer surfaced because it confused the team — it only bumps when native
// code changes (new permissions / SDK upgrade), so for day-to-day JS-only
// updates everyone was looking at the same "0.1.0" forever.

export function getDisplayVersion(): string {
  const isEmbedded = Updates.isEmbeddedLaunch ?? true;
  const otaShort = isEmbedded
    ? "(embedded)"
    : Updates.updateId
      ? `OTA ${Updates.updateId.slice(0, 8)}`
      : "(OTA)";

  return `${APP_VERSION} · ${otaShort}`;
}

// Kept exported for any future place that needs the underlying native
// binary version (e.g. crash-report metadata). Not currently surfaced in UI.
export function getNativeBinaryVersion(): string {
  const appVersion = Constants.expoConfig?.version || "?.?.?";
  const buildNumber =
    Constants.nativeBuildVersion ||
    Constants.expoConfig?.ios?.buildNumber ||
    Constants.expoConfig?.android?.versionCode?.toString() ||
    null;
  return `v${appVersion}${buildNumber ? ` b${buildNumber}` : ""}`;
}
