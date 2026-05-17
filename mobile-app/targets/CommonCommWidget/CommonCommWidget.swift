// Home-screen widget: three big shortcut buttons for the app's primary
// tabs (Chats, My tickets, Team). Each button is a SwiftUI `Link` that
// opens a `commoncomm://` deep link; React Navigation's `linking` config
// resolves the path to the matching tab inside the app.
//
// v1.140: each tile now shows a pink unread-indicator dot in the top-
// right when there's activity in that category. The counts come from
// the React Native app via the WidgetUpdater Expo module, which writes
// them to a UserDefaults suite scoped to the App Group
// `group.com.aroleap.commoncomm`. The widget reads the suite in
// getTimeline; the app side calls WidgetCenter.shared.reloadAllTimelines()
// to ask the system to refresh us — usually within a second.

import WidgetKit
import SwiftUI

// Keep in sync with modules/widget-updater/ios/WidgetUpdaterModule.swift
// — same App Group identifier, same key names. There is no shared
// constants file across the host app and the extension; agreement is
// by convention.
private let APP_GROUP = "group.com.aroleap.commoncomm"
private let KEY_CHATS = "chats"
private let KEY_TICKETS = "tickets"
private let KEY_TEAM = "team"

struct CommonCommEntry: TimelineEntry {
    let date: Date
    let chatsUnread: Int
    let ticketsUnread: Int
    let teamUnread: Int
}

struct CommonCommProvider: TimelineProvider {
    func placeholder(in context: Context) -> CommonCommEntry {
        // Snapshot used by Springboard when the widget is first being
        // added to the home screen. Zero counts is safest — Apple
        // explicitly recommends not faking data here.
        CommonCommEntry(date: Date(), chatsUnread: 0, ticketsUnread: 0, teamUnread: 0)
    }

    func getSnapshot(in context: Context, completion: @escaping (CommonCommEntry) -> Void) {
        completion(readEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CommonCommEntry>) -> Void) {
        // `.never` — the widget only updates when WidgetUpdater pings
        // WidgetCenter.reloadAllTimelines() from the host app. That's
        // typically within a second of an unread-count change in JS,
        // which is what we want; periodic auto-refresh would waste
        // battery for no benefit.
        let timeline = Timeline(entries: [readEntry()], policy: .never)
        completion(timeline)
    }

    // Pull the latest counts out of the shared UserDefaults suite. If
    // the App Group isn't entitled (provisioning misconfigured), the
    // call returns nil and every count reads as 0 — same as fresh
    // install. Failing closed feels right for an unread indicator.
    private func readEntry() -> CommonCommEntry {
        let defaults = UserDefaults(suiteName: APP_GROUP)
        return CommonCommEntry(
            date: Date(),
            chatsUnread: defaults?.integer(forKey: KEY_CHATS) ?? 0,
            ticketsUnread: defaults?.integer(forKey: KEY_TICKETS) ?? 0,
            teamUnread: defaults?.integer(forKey: KEY_TEAM) ?? 0
        )
    }
}

struct CommonCommWidgetEntryView: View {
    var entry: CommonCommProvider.Entry

    var body: some View {
        HStack(spacing: 12) {
            WidgetButton(
                title: "Chat",
                symbol: "bubble.left.and.bubble.right.fill",
                url: URL(string: "commoncomm://chats")!,
                hasUnread: entry.chatsUnread > 0
            )
            WidgetButton(
                title: "My tickets",
                symbol: "ticket.fill",
                url: URL(string: "commoncomm://tickets")!,
                hasUnread: entry.ticketsUnread > 0
            )
            WidgetButton(
                title: "Team",
                symbol: "person.2.fill",
                url: URL(string: "commoncomm://team")!,
                hasUnread: entry.teamUnread > 0
            )
        }
        .padding(12)
        .containerBackground(for: .widget) {
            Color(red: 0.0, green: 0.50, blue: 0.41) // #008069 brand green
        }
    }
}

// A single shortcut tile inside the widget. `Link` is the WidgetKit-blessed
// way to open a URL from a medium/large widget tap target; the system
// handles the launch and hands the URL to the host app via openURL.
//
// v1.140: when hasUnread is true we overlay a pink Circle in the top-
// right corner. ZStack with topTrailing alignment lets us float the
// dot above the tile without resizing it, matching the Android tile's
// FrameLayout + layout_gravity="top|end" pixel-for-pixel.
struct WidgetButton: View {
    let title: String
    let symbol: String
    let url: URL
    let hasUnread: Bool

    var body: some View {
        Link(destination: url) {
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 6) {
                    Image(systemName: symbol)
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundColor(.white)
                    Text(title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.white.opacity(0.18))
                .cornerRadius(14)

                if hasUnread {
                    // Matches widget_dot.xml on Android — same pink, same
                    // thin white outline so the dot reads against the
                    // semi-transparent tile background.
                    Circle()
                        .fill(Color(red: 0.93, green: 0.28, blue: 0.60)) // #EC4899
                        .frame(width: 10, height: 10)
                        .overlay(
                            Circle()
                                .stroke(Color.white, lineWidth: 1)
                        )
                        .padding(.top, 6)
                        .padding(.trailing, 6)
                }
            }
        }
    }
}

struct CommonCommWidget: Widget {
    let kind: String = "CommonCommWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CommonCommProvider()) { entry in
            CommonCommWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("CommonComm shortcuts")
        .description("Quick access to Chats, My tickets, and Team.")
        // Medium is the right form factor for a 3-button row. Small is too
        // cramped for three tiles with labels; large wastes space.
        .supportedFamilies([.systemMedium])
    }
}

#Preview(as: .systemMedium) {
    CommonCommWidget()
} timeline: {
    CommonCommEntry(date: Date(), chatsUnread: 0, ticketsUnread: 0, teamUnread: 0)
    CommonCommEntry(date: Date(), chatsUnread: 3, ticketsUnread: 0, teamUnread: 1)
}
