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
  ios: {
    bundleIdentifier: "com.aroleap.commoncomm",
    supportsTablet: false,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: "com.aroleap.commoncomm",
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
