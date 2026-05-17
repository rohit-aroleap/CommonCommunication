// iOS half of the WidgetUpdater bridge. Mirror of the Android module —
// receives three unread counts from JS, persists them to a UserDefaults
// suite scoped to the App Group `group.com.aroleap.commoncomm`, then
// asks WidgetCenter to reload every active timeline so the widget
// extension re-renders with fresh dot visibility.
//
// Why App Group UserDefaults (rather than the app's regular Defaults)?
// The widget runs as a separate iOS extension process. It can only
// reach data the host app has explicitly shared via App Groups; without
// the group entitlement on both sides, the widget would see an empty
// UserDefaults no matter what the app writes.
//
// Apple Developer portal setup is required ONE TIME — see
// targets/CommonCommWidget/expo-target.config.js and app.config.js for
// the exact `group.com.aroleap.commoncomm` ID, and widget/README.md
// for the click-through steps.

import ExpoModulesCore
import WidgetKit

// Must match the App Group declared in:
//   • app.config.js (host app entitlements)
//   • targets/CommonCommWidget/expo-target.config.js (widget entitlements)
//   • CommonCommWidget.swift (where the widget reads from)
private let APP_GROUP = "group.com.aroleap.commoncomm"

// Keys agree with the widget's read side and with the Android module's
// SharedPreferences keys — same names everywhere makes the cross-
// platform debugging story bearable.
private let KEY_CHATS = "chats"
private let KEY_TICKETS = "tickets"
private let KEY_TEAM = "team"

public class WidgetUpdaterModule: Module {
    public func definition() -> ModuleDefinition {
        Name("WidgetUpdater")

        Function("setUnreadCounts") { (chats: Int, tickets: Int, team: Int) in
            // Standalone UserDefaults instance scoped to the App Group.
            // If the group isn't entitled (provisioning misconfigured /
            // App Group not registered in the developer portal), this
            // returns nil and we bail rather than silently writing to
            // the host app's private store where the widget can never
            // see it.
            guard let defaults = UserDefaults(suiteName: APP_GROUP) else {
                return
            }
            defaults.set(chats, forKey: KEY_CHATS)
            defaults.set(tickets, forKey: KEY_TICKETS)
            defaults.set(team, forKey: KEY_TEAM)

            // Triggers the widget extension's TimelineProvider to run
            // again on the system's next available render pass — usually
            // within a second. Cheap to call frequently; iOS coalesces
            // bursts so a stream of count changes won't hammer the GPU.
            if #available(iOS 14.0, *) {
                WidgetCenter.shared.reloadAllTimelines()
            }
        }
    }
}
