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
    url: `https://u.expo.dev/${e.EAS_PROJECT_ID ?? ""}`,
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
        "Record a voice note to send to a customer in a WhatsApp chat.",
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
    eas: { projectId: e.EAS_PROJECT_ID ?? "" },
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
