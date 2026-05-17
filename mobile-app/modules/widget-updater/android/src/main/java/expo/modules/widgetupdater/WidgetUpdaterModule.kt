// Native module bridge between the React Native app and the Android
// home-screen widget. The app calls setUnreadCounts whenever its in-memory
// counts change (see useWidgetSync hook); this module persists the values
// to SharedPreferences and broadcasts an APPWIDGET_UPDATE intent so the
// AppWidgetProvider re-renders with fresh dot visibility within a second.
//
// Why SharedPreferences (rather than Intent extras)?
// The widget can also be redrawn by the system on its own schedule
// (config changes, reboot, etc.) at which point onUpdate runs without
// any extras we set. Persisting to prefs is the only way to keep the
// counts available across those rebuilds. The widget reads them in
// onUpdate -- see CommonCommWidgetProvider.kt.

package expo.modules.widgetupdater

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Must match the values in CommonCommWidgetProvider.kt. If you rename
// anything here, rename it there too — there is no shared header file
// across the prebuild boundary.
private const val PREFS_NAME = "commoncomm_widget"
private const val KEY_CHATS = "chats"
private const val KEY_TICKETS = "tickets"
private const val KEY_TEAM = "team"

// Fully-qualified class name of the widget provider. The widget code is
// copied into this package by the with-widget config plugin during
// prebuild; keep this string in sync if the plugin moves the destination.
private const val WIDGET_PROVIDER_CLASS =
    "com.aroleap.commoncomm.widget.CommonCommWidgetProvider"

class WidgetUpdaterModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("WidgetUpdater")

        Function("setUnreadCounts") { chats: Int, tickets: Int, team: Int ->
            val context = appContext.reactContext ?: return@Function

            // Persist the new values. apply() is fire-and-forget — fine here
            // because the broadcast below races onUpdate which races the
            // write, and worst case onUpdate reads slightly stale prefs;
            // a follow-up setUnreadCounts call corrects it within ms.
            context
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putInt(KEY_CHATS, chats)
                .putInt(KEY_TICKETS, tickets)
                .putInt(KEY_TEAM, team)
                .apply()

            // Find every active instance of our widget and tell it to redraw.
            // If no widgets are installed (user hasn't added one to their
            // home screen), getAppWidgetIds returns an empty array and we
            // skip the broadcast entirely — no point waking dead receivers.
            val manager = AppWidgetManager.getInstance(context)
            val componentName = ComponentName(context.packageName, WIDGET_PROVIDER_CLASS)
            val widgetIds = try {
                manager.getAppWidgetIds(componentName)
            } catch (e: IllegalArgumentException) {
                // Receiver isn't registered yet — happens on the very first
                // install before AGP rewires the manifest. Bail rather than
                // crash; the widget literally cannot exist in this state.
                IntArray(0)
            }
            if (widgetIds.isEmpty()) return@Function

            val intent = Intent(context, Class.forName(WIDGET_PROVIDER_CLASS)).apply {
                action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, widgetIds)
            }
            context.sendBroadcast(intent)
        }
    }
}
