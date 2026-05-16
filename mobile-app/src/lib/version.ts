import Constants from "expo-constants";
import * as Updates from "expo-updates";

// Source of truth for the user-visible version string.
//
// Layers we surface:
//   - appVersion: the marketing version from app.config.js (e.g. "0.1.0").
//     Bumps only when native code changes (new permissions, new modules,
//     SDK upgrade) — requires a new TestFlight / APK build.
//   - buildNumber: the iOS/Android build number EAS auto-increments per
//     production build. Useful for telling two builds of the same
//     appVersion apart.
//   - otaId: when an OTA bundle is loaded via expo-updates, the short id
//     of that bundle. Tells me which JS bundle is actually running. If the
//     app is on the bundle that shipped inside the binary, this is
//     "(embedded)".
//
// The display string is intentionally compact so it fits in tiny footer
// chips: "v0.1.0 b5 · OTA abc12345" or "v0.1.0 b5 (embedded)".

export function getDisplayVersion(): string {
  const appVersion = Constants.expoConfig?.version || "?.?.?";
  const buildNumber =
    Constants.nativeBuildVersion ||
    Constants.expoConfig?.ios?.buildNumber ||
    Constants.expoConfig?.android?.versionCode?.toString() ||
    null;

  const isEmbedded = Updates.isEmbeddedLaunch ?? true;
  const otaShort = isEmbedded
    ? "(embedded)"
    : Updates.updateId
      ? `OTA ${Updates.updateId.slice(0, 8)}`
      : "(OTA)";

  return `v${appVersion}${buildNumber ? ` b${buildNumber}` : ""} · ${otaShort}`;
}
