// Target definition consumed by @bacons/apple-targets. Tells the plugin
// to register a WidgetKit extension target in the Xcode project during
// `expo prebuild`, embed it into the main app, and enable the App Group
// capability so the widget and the host app can share UserDefaults
// (which is how unread-count dots get from JS to the widget — see
// modules/widget-updater/ios/WidgetUpdaterModule.swift).
//
// The App Group identifier `group.com.aroleap.commoncomm` must also be
// registered in the Apple Developer portal (Identifiers → App Groups →
// "+"), and added as a capability to BOTH the host app's App ID and
// the widget extension's App ID. Without that registration, code signing
// fails at the EAS Build step. See widget/README.md for the checklist.

/** @type {import('@bacons/apple-targets').Config} */
module.exports = {
  type: "widget",
  // Default to the deployment target the main app uses. iOS 17+ unlocks
  // SwiftUI containerBackground + interactive widget niceties; bump if
  // we ever need a feature gated on a higher minimum.
  deploymentTarget: "17.0",
  entitlements: {
    "com.apple.security.application-groups": ["group.com.aroleap.commoncomm"],
  },
};
