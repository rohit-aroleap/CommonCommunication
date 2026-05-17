# Home-screen widget

A native iOS/Android home-screen widget with three shortcut buttons —
**Chat**, **My tickets**, **Team** — matching the in-app bottom tabs. Each
button deep-links into the app via the `commoncomm://` URL scheme; React
Navigation's `linking` config in `App.tsx` resolves the path to the right
tab.

## Layout

```
widget/
├── README.md
├── ios/
│   ├── CommonCommWidget.swift          # WidgetKit UI + provider
│   ├── CommonCommWidgetBundle.swift    # @main bundle entry point
│   └── Info.plist                      # Extension Info.plist
└── android/
    ├── kotlin/
    │   └── CommonCommWidgetProvider.kt # AppWidgetProvider
    └── res/
        ├── drawable/
        │   ├── widget_bg.xml
        │   └── widget_tile_bg.xml
        ├── layout/
        │   └── common_comm_widget.xml
        ├── values/
        │   └── strings.xml
        └── xml/
            └── common_comm_widget_info.xml
```

The `plugins/with-widget.js` Expo config plugin copies these files into
the generated `android/` and `ios/` projects during `expo prebuild` and
patches `AndroidManifest.xml` with the AppWidgetProvider `<receiver>`.

## Building

This widget cannot be tested in Expo Go — Expo Go's binary doesn't include
custom native targets. Use a dev client or release build.

```sh
cd mobile-app
npx expo prebuild --clean       # regenerate ios/ and android/
eas build --profile development # or --profile production
```

## Android: just works after prebuild

The config plugin handles everything:
- Copies the Kotlin AppWidgetProvider into the package directory
- Copies layout/xml/drawable/values resources into `app/src/main/res/`
- Adds the `<receiver>` to `AndroidManifest.xml`

After `expo prebuild`, the widget shows up in the launcher's widget picker
under the app name.

## iOS: one manual Xcode step

WidgetKit extensions require a real Xcode target, which can't be added
purely from a config plugin without manipulating the `.pbxproj` directly.
The plugin copies the Swift sources to `ios/CommonCommWidget/`; the
target needs to be added once:

1. `npx expo prebuild --clean`
2. Open `ios/commoncomm-mobile.xcworkspace` in Xcode
3. **File → New → Target… → Widget Extension**
   - Product name: `CommonCommWidget`
   - Bundle identifier: `com.aroleap.commoncomm.CommonCommWidget`
   - Language: Swift
   - Uncheck "Include Configuration Intent"
4. Delete the auto-generated `CommonCommWidget.swift` and
   `CommonCommWidgetBundle.swift` Xcode created
5. Right-click the new target's folder → **Add Files to…** → select the
   three files in `ios/CommonCommWidget/` (`CommonCommWidget.swift`,
   `CommonCommWidgetBundle.swift`, `Info.plist`)
6. In the target's **Info** tab, ensure the Info.plist path points to the
   one we ship (or merge the WidgetKit extension keys into Xcode's auto
   one)
7. Build and run on a physical device (widgets don't render in the
   simulator's home screen the same way)

After step 7, long-press the iOS home screen → **+** → search for the
app name → add the medium widget. Once added, it persists across builds;
the manual setup is a one-time cost.

If you want to automate the Xcode target step, the cleanest path is
adopting [`@bacons/apple-targets`](https://github.com/EvanBacon/expo-apple-targets)
as a dependency and converting `widget/ios/` into a target spec.

## Deep linking

Each button opens a URL handled by `App.tsx`'s `linking` config:

| Button     | URL                       | Tab     |
|------------|---------------------------|---------|
| Chat       | `commoncomm://chats`      | Chats   |
| My tickets | `commoncomm://tickets`    | Tickets |
| Team       | `commoncomm://team`       | Team    |

If you change the tab names in `App.tsx`, update both:
- The `linking.config.screens.Tabs.screens` map in `App.tsx`
- The URLs in `widget/ios/CommonCommWidget.swift` (search for `commoncomm://`)
- The URLs in `widget/android/kotlin/CommonCommWidgetProvider.kt`

## Adding live unread counts later

The iOS provider currently returns a single static timeline entry. To
show live counts (e.g. unread Chats badge on the Chat tile):

1. Set up a shared App Group between the app and the widget extension
2. From the React Native side, write counts to the shared
   `UserDefaults`/`NSUbiquitousKeyValueStore` via a small native module
3. Change `CommonCommProvider.getTimeline` to read those values and emit
   a new entry every 15 minutes (the iOS minimum) or via
   `WidgetCenter.shared.reloadAllTimelines()` from the app when counts
   change

On Android: same idea with `SharedPreferences` and
`AppWidgetManager.notifyAppWidgetViewDataChanged`. Keep in mind that
Android widget update intervals are capped at 30 minutes — push updates
from the app when state changes for snappier behavior.
