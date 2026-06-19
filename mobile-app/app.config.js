// Replaces app.json. Lets us inject env-driven values (OAuth client IDs, EAS
// project ID) at config-time rather than checking them into git. Expo's CLI
// auto-loads `.env` from this directory; populate it from .env.example.
//
// The Google client IDs aren't true secrets — they ship in the app binary
// either way — but keeping them out of the repo means a forked / public
// version of the repo doesn't expose your Firebase project to random sign-in
// attempts and keeps the OAuth consent screen tidy.

require("dotenv").config();

const e = process.env;

// EAS project ID. This is NOT a secret — it ships in the public OTA update URL
// (https://u.expo.dev/<id>) regardless. It MUST have a hardcoded fallback:
// `.env` is git-ignored and is NOT uploaded to EAS cloud builds, so relying on
// the env var alone produced cloud binaries with an empty update URL
// ("https://u.expo.dev/") that could never pull an OTA. Keep the env override
// for flexibility, but always fall back to the real ID so every build — local
// or cloud — bakes in a working update endpoint.
const EAS_PROJECT_ID = e.EAS_PROJECT_ID ?? "1b355b67-849c-479d-8c56-4534d62b61f6";

module.exports = ({ config }) => ({
  ...config,
  name: "CommonCommunication",
  slug: "commoncomm-mobile",
  scheme: "commoncomm",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#008069",
  },
  assetBundlePatterns: ["**/*"],
  // EAS Update (OTA) config. Once expo-updates is installed and `eas update`
  // has been run once, JS-only changes ship without a new TestFlight build.
  // runtimeVersion.policy = "appVersion" ties an OTA bundle to a specific
  // version string — bump `version` above only when you change native code
  // (new permissions, new modules), then re-build via TestFlight. JS-only
  // tweaks reuse the existing runtimeVersion and ship via `eas update`.
  runtimeVersion: { policy: "appVersion" },
  updates: {
    url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
    fallbackToCacheTimeout: 0,
    checkAutomatically: "ON_LOAD",
  },
  ios: {
    bundleIdentifier: "com.aroleap.commoncomm",
    buildNumber: "1",
    supportsTablet: false,
    // Apple wants every app to declare its encryption posture. We only use
    // standard HTTPS, so we tag as non-exempt = false. Without this, TestFlight
    // submissions get blocked until you fill it in App Store Connect each time.
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // iOS requires a usage description for every Apple-flagged data source.
      // expo-image-picker injects these via its plugin (below), but Apple
      // sometimes still rejects if the strings are too generic. Specifics here:
      NSPhotoLibraryUsageDescription:
        "Choose a photo or video to send to a customer in a WhatsApp chat.",
      NSCameraUsageDescription:
        "Take a photo to send to a customer in a WhatsApp chat.",
      NSMicrophoneUsageDescription:
        "Record a voice note or strength assessment session.",
      // v1.236: declare audio as a background mode so SA recording keeps
      // running when the trainer locks the phone or switches apps mid-
      // session. Without this entry, iOS suspends audio capture the
      // instant the app goes to background. Combined with expo-audio's
      // staysActiveInBackground flag in setAudioModeAsync at runtime.
      UIBackgroundModes: ["audio"],
    },
    // App Group entitlement so the host app and the WidgetKit extension
    // can share a UserDefaults suite. The widget reads the three unread
    // counts from this group; the WidgetUpdater Expo module writes them
    // every time the in-app counts change. The matching capability MUST
    // ALSO be enabled on the widget target — see
    // targets/CommonCommWidget/expo-target.config.js.
    //
    // Apple Developer portal setup (one-time, manual): Identifiers →
    // App Groups → register `group.com.aroleap.commoncomm`, then add it
    // as a capability to BOTH com.aroleap.commoncomm AND
    // com.aroleap.commoncomm.CommonCommWidget App IDs. Without this,
    // code signing fails during EAS Build.
    entitlements: {
      "com.apple.security.application-groups": [
        "group.com.aroleap.commoncomm",
      ],
    },
  },
  android: {
    package: "com.aroleap.commoncomm",
    // FCM config needed for Android push notifications. The file is
    // .gitignored — each developer/build needs their own download from
    // Firebase Console → motherofdashboard → Project settings → General
    // → Android app for com.aroleap.commoncomm → Download
    // google-services.json. Without this file, expo-notifications fails
    // to retrieve a token on Android (silent, no error) and pushes never
    // arrive.
    googleServicesFile: "./google-services.json",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#008069",
    },
    permissions: [
      "NOTIFICATIONS",
      "RECEIVE_BOOT_COMPLETED",
      "READ_EXTERNAL_STORAGE",
      "READ_MEDIA_IMAGES",
      "READ_MEDIA_VIDEO",
      "READ_MEDIA_AUDIO",
      "RECORD_AUDIO",
      // v1.236: foreground-service permissions for background SA
      // recording on Android 14+. WAKE_LOCK keeps the CPU awake during
      // long sessions so the recorder doesn't doze off. FOREGROUND_SERVICE
      // is the umbrella permission; FOREGROUND_SERVICE_MICROPHONE is the
      // typed sub-permission Android 14 requires when the service uses
      // the mic. Without these the OS kills the recording the moment
      // the app goes to background.
      "WAKE_LOCK",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_MICROPHONE",
      // v1.268: incoming-call background ring. The data-only Expo Push
      // arrives even when the app is killed; Notifee then displays a
      // call-style full-screen notification on the lock screen with
      // Accept / Decline actions. Permissions needed:
      //   VIBRATE                — the call ringtone vibrates
      //   USE_FULL_SCREEN_INTENT — locked-screen full-screen ring (Android 14
      //                            requires this declared explicitly)
      //   POST_NOTIFICATIONS     — Android 13+ runtime permission for any
      //                            notification (we already register it via
      //                            expo-notifications, declared here for
      //                            clarity and to satisfy Notifee's check)
      //   FOREGROUND_SERVICE_PHONE_CALL — Android 14+ typed sub-permission
      //                            for the foreground service Notifee runs
      //                            while displaying the call notification
      "VIBRATE",
      "USE_FULL_SCREEN_INTENT",
      "POST_NOTIFICATIONS",
      "FOREGROUND_SERVICE_PHONE_CALL",
    ],
  },
  web: { favicon: "./assets/favicon.png" },
  plugins: [
    [
      "expo-image-picker",
      {
        photosPermission: "Attach images and videos to customer chats",
        cameraPermission: "Take a photo to send to a customer",
      },
    ],
    ["expo-document-picker", { iCloudContainerEnvironment: "Production" }],
    ["expo-notifications", { color: "#008069" }],
    "expo-updates",
    // Home-screen widget plumbing — split across two plugins:
    //  • @bacons/apple-targets discovers every directory under targets/
    //    that has an expo-target.config.js, creates the matching Xcode
    //    target during prebuild (Widget Extension in our case), and
    //    embeds it into the host app. Eliminates the previous "open
    //    Xcode and click Add Target" manual step.
    //  • with-widget.js handles the Android side only now — copies the
    //    Kotlin provider + res/ into the prebuilt android/ tree and
    //    patches AndroidManifest.xml with the AppWidgetProvider
    //    receiver. The iOS file-copy that used to live in this plugin
    //    has been retired; sources live in targets/CommonCommWidget/.
    "@bacons/apple-targets",
    "./plugins/with-widget.js",
  ],
  extra: {
    eas: { projectId: EAS_PROJECT_ID },
    googleSignIn: {
      iosClientId: e.GOOGLE_IOS_CLIENT_ID ?? "",
      androidClientId: e.GOOGLE_ANDROID_CLIENT_ID ?? "",
      webClientId: e.GOOGLE_WEB_CLIENT_ID ?? "",
    },
    workerUrl:
      e.WORKER_URL ??
      "https://common-communication.rohitpatel-mailid297.workers.dev",
  },
});
