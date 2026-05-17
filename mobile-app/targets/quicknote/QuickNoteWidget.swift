// QuickNoteWidget — iOS home-screen widget for CommonCommunication.
//
// The widget is intentionally minimal: it's a tap-target, not a data
// surface. Tapping anywhere on the tile fires the `commoncomm://quick-note`
// deep link, which React Navigation's `linking` config in App.tsx catches
// and routes to QuickNoteScreen. The screen then auto-starts the mic.
//
// Widgets cannot record audio themselves (WidgetKit is render-only), so
// this is the only viable shape for a "tap and start dictating" flow on
// iOS. The widget tile shows a pencil icon and the label "Quick Note" on
// the brand-green background.
//
// Static timeline: the tile content never changes, so we emit one entry
// and tell WidgetKit not to refresh — saves the widget's daily reload
// budget for actually-dynamic widgets if we add them later.

import WidgetKit
import SwiftUI

struct QuickNoteEntry: TimelineEntry {
    let date: Date
}

struct QuickNoteProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuickNoteEntry {
        QuickNoteEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (QuickNoteEntry) -> Void) {
        completion(QuickNoteEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<QuickNoteEntry>) -> Void) {
        // Single entry, never refresh — the tile is static.
        let timeline = Timeline(entries: [QuickNoteEntry(date: Date())], policy: .never)
        completion(timeline)
    }
}

struct QuickNoteWidgetView: View {
    var entry: QuickNoteEntry

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 36, weight: .medium))
                .foregroundStyle(.white)
            Text("Quick Note")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
            Text("Tap to dictate")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.85))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The deep-link URL is intercepted by the host app's CFBundleURLTypes
        // (the "commoncomm" scheme registered in app.config.js). React
        // Navigation's `linking` config in App.tsx maps `commoncomm://
        // quick-note` to the QuickNote stack screen.
        .widgetURL(URL(string: "commoncomm://quick-note"))
        .containerBackground(for: .widget) {
            Color("WidgetBackground")
        }
    }
}

struct QuickNoteWidget: Widget {
    let kind: String = "QuickNoteWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: QuickNoteProvider()) { entry in
            QuickNoteWidgetView(entry: entry)
        }
        .configurationDisplayName("Quick Note")
        .description("Dictate a note and tag a customer in seconds.")
        // systemSmall is the only size for a one-tap shortcut. systemMedium
        // and Large would just add empty space.
        .supportedFamilies([.systemSmall])
    }
}

@main
struct QuickNoteWidgetBundle: WidgetBundle {
    var body: some Widget {
        QuickNoteWidget()
    }
}

#Preview(as: .systemSmall) {
    QuickNoteWidget()
} timeline: {
    QuickNoteEntry(date: .now)
}
