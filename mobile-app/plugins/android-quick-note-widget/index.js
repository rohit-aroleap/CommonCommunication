// Custom Expo config plugin that wires up the Android Quick Note widget.
// There's no widely-adopted Expo plugin for Android home-screen widgets, so
// we ship a small one alongside the app.
//
// At prebuild time we:
//   1. Add a <receiver> to AndroidManifest.xml so Android knows about the
//      QuickNoteWidgetProvider class.
//   2. Copy the Kotlin source into the app's package directory (rewriting
//      its `package` declaration to match config.android.package so the
//      plugin keeps working if the app gets renamed).
//   3. Copy the widget layout, AppWidgetProviderInfo XML, and the pencil
//      vector drawable into the generated res/ tree.
//
// Re-runs cleanly: every copy is idempotent and the manifest mutation
// checks for an existing receiver before adding one. Safe to invoke on
// `expo prebuild --clean` and on partial prebuilds.

const fs = require("fs");
const path = require("path");
const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");

const PLUGIN_DIR = __dirname;
const RECEIVER_NAME = ".QuickNoteWidgetProvider";

function withAndroidQuickNoteWidget(config) {
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults?.manifest;
    const application = manifest?.application?.[0];
    if (!application) return config;

    application.receiver = application.receiver || [];
    const already = application.receiver.find(
      (r) => r?.$?.["android:name"] === RECEIVER_NAME,
    );
    if (!already) {
      application.receiver.push({
        $: {
          "android:name": RECEIVER_NAME,
          "android:exported": "true",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name": "android.appwidget.action.APPWIDGET_UPDATE",
                },
              },
            ],
          },
        ],
        "meta-data": [
          {
            $: {
              "android:name": "android.appwidget.provider",
              "android:resource": "@xml/quick_note_widget_info",
            },
          },
        ],
      });
    }
    return config;
  });

  config = withDangerousMod(config, [
    "android",
    async (config) => {
      const androidRoot = config.modRequest.platformProjectRoot;
      const packageName =
        config.android?.package || "com.aroleap.commoncomm";
      const packagePath = packageName.replace(/\./g, "/");
      const javaDir = path.join(
        androidRoot,
        "app",
        "src",
        "main",
        "java",
        packagePath,
      );
      const resDir = path.join(androidRoot, "app", "src", "main", "res");

      ensureDir(javaDir);
      ensureDir(path.join(resDir, "xml"));
      ensureDir(path.join(resDir, "layout"));
      ensureDir(path.join(resDir, "drawable"));

      // Kotlin source: rewrite the package declaration to match
      // config.android.package. The template's literal package is
      // com.aroleap.commoncomm but we don't want to hard-depend on that.
      const kotlinSrc = fs.readFileSync(
        path.join(PLUGIN_DIR, "QuickNoteWidgetProvider.kt"),
        "utf8",
      );
      const rewritten = kotlinSrc.replace(
        /^package .+$/m,
        `package ${packageName}`,
      );
      fs.writeFileSync(
        path.join(javaDir, "QuickNoteWidgetProvider.kt"),
        rewritten,
      );

      copy(
        path.join(PLUGIN_DIR, "res", "layout", "quick_note_widget.xml"),
        path.join(resDir, "layout", "quick_note_widget.xml"),
      );
      copy(
        path.join(PLUGIN_DIR, "res", "xml", "quick_note_widget_info.xml"),
        path.join(resDir, "xml", "quick_note_widget_info.xml"),
      );
      copy(
        path.join(PLUGIN_DIR, "res", "drawable", "ic_quick_note.xml"),
        path.join(resDir, "drawable", "ic_quick_note.xml"),
      );

      return config;
    },
  ]);

  return config;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copy(src, dest) {
  fs.copyFileSync(src, dest);
}

module.exports = withAndroidQuickNoteWidget;
