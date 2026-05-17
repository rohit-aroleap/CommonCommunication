// Home-screen widget: three big shortcut buttons for the app's primary
// tabs (Chats, My tickets, Team). Each button is a SwiftUI `Link` that
// opens a `commoncomm://` deep link; React Navigation's `linking` config
// resolves the path to the matching tab inside the app.
//
// The widget is static — no timeline data needed — so the Provider
// returns a single placeholder entry that never changes. If we later
// want live unread counts on the widget, we'll fetch them from a shared
// App Group container and rebuild the timeline.

import WidgetKit
import SwiftUI

struct CommonCommEntry: TimelineEntry {
    let date: Date
}

struct CommonCommProvider: TimelineProvider {
    func placeholder(in context: Context) -> CommonCommEntry {
        CommonCommEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (CommonCommEntry) -> Void) {
        completion(CommonCommEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CommonCommEntry>) -> Void) {
        // `.never` — the widget content doesn't depend on time. If/when we
        // wire live unread counts in, switch to `.after(date)` with a short
        // reload interval (15 min minimum on iOS).
        let timeline = Timeline(entries: [CommonCommEntry(date: Date())], policy: .never)
        completion(timeline)
    }
}

struct CommonCommWidgetEntryView: View {
    var entry: CommonCommProvider.Entry

    var body: some View {
        HStack(spacing: 12) {
            WidgetButton(
                title: "Chat",
                symbol: "bubble.left.and.bubble.right.fill",
                url: URL(string: "commoncomm://chats")!
            )
            WidgetButton(
                title: "My tickets",
                symbol: "ticket.fill",
                url: URL(string: "commoncomm://tickets")!
            )
            WidgetButton(
                title: "Team",
                symbol: "person.2.fill",
                url: URL(string: "commoncomm://team")!
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
struct WidgetButton: View {
    let title: String
    let symbol: String
    let url: URL

    var body: some View {
        Link(destination: url) {
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
    CommonCommEntry(date: Date())
}
