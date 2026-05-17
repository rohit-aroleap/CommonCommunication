// Expo config plugin for the Android side of the home-screen widget.
// iOS has moved to @bacons/apple-targets (see app.config.js plugins
// list + targets/CommonCommWidget/) — that plugin creates the Xcode
// Widget Extension target during prebuild, eliminating the manual
// "open Xcode, add target" step the iOS path used to need.
//
// What this file still does (Android only):
//   • Copy widget/android/res/* into android/app/src/main/res/
//   • Copy widget/android/kotlin/* into the app's package dir
//   • Patch AndroidManifest.xml with the AppWidgetProvider <receiver>
//
// Run `npx expo prebuild --clean` after editing this file or any of
// the files under widget/android/ to see the changes reflected in the
// native projects. EAS Build also runs prebuild as the first step, so
// committed changes here propagate into release builds automatically.

const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const WIDGET_SRC = path.join(__dirname, "..", "widget");

// Recursive copy that mirrors directory structure under `dest`. We avoid
// fs.cpSync's `force: true` shortcut so we can log per-file copies; it's
// also useful for debugging when a file fails to land in the right place.
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function withAndroidWidgetFiles(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const projectRoot = cfg.modRequest.platformProjectRoot;
      const resDest = path.join(projectRoot, "app", "src", "main", "res");
      copyDir(path.join(WIDGET_SRC, "android", "res"), resDest);

      // Kotlin sources land under com/aroleap/commoncomm/widget/ so the
      // package declaration in the .kt file resolves correctly.
      const javaPkgDir = path.join(
        projectRoot,
        "app",
        "src",
        "main",
        "java",
        "com",
        "aroleap",
        "commoncomm",
        "widget",
      );
      copyDir(path.join(WIDGET_SRC, "android", "kotlin"), javaPkgDir);

      return cfg;
    },
  ]);
}

function withAndroidWidgetManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) return cfg;

    application.receiver = application.receiver || [];
    const already = application.receiver.find(
      (r) =>
        r?.$?.["android:name"] === ".widget.CommonCommWidgetProvider" ||
        r?.$?.["android:name"] ===
          "com.aroleap.commoncomm.widget.CommonCommWidgetProvider",
    );
    if (already) return cfg;

    application.receiver.push({
      $: {
        "android:name": "com.aroleap.commoncomm.widget.CommonCommWidgetProvider",
        "android:exported": "true",
        "android:label": "@string/widget_label",
      },
      "intent-filter": [
        {
          action: [
            { $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } },
          ],
        },
      ],
      "meta-data": [
        {
          $: {
            "android:name": "android.appwidget.provider",
            "android:resource": "@xml/common_comm_widget_info",
          },
        },
      ],
    });

    return cfg;
  });
}

module.exports = function withWidget(config) {
  config = withAndroidWidgetFiles(config);
  config = withAndroidWidgetManifest(config);
  return config;
};
