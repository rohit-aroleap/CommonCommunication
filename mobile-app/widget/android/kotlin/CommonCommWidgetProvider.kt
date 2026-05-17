// Home-screen App Widget for CommonComm. Renders three shortcut buttons
// (Chat, My tickets, Team) that each fire a deep link into the React
// Native app via the `commoncomm://` scheme. React Navigation's `linking`
// config resolves the path to the matching tab.
//
// v1.139: each tile now shows an unread-indicator dot when there's
// activity in that category. The counts come from the React Native app
// via the WidgetUpdater Expo module, which writes them to a shared
// SharedPreferences file and broadcasts an APPWIDGET_UPDATE so this
// provider re-runs. Counts are read once per onUpdate — if SharedPrefs
// is empty (very first install, before the app has had a chance to push
// any counts) all three dots stay hidden.

package com.aroleap.commoncomm.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import com.aroleap.commoncomm.R

// Must match the keys written by WidgetUpdaterModule.kt. Out-of-band
// coupling — there is no shared Kotlin source file between the widget
// (copied via with-widget config plugin) and the Expo module, so the
// two sides agree on names by convention.
private const val PREFS_NAME = "commoncomm_widget"
private const val KEY_CHATS = "chats"
private const val KEY_TICKETS = "tickets"
private const val KEY_TEAM = "team"

class CommonCommWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        // Read once; reuse across all widget instances in this update pass.
        // (Multiple widgets is rare on home screens but supported by the API.)
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val chatsCount = prefs.getInt(KEY_CHATS, 0)
        val ticketsCount = prefs.getInt(KEY_TICKETS, 0)
        val teamCount = prefs.getInt(KEY_TEAM, 0)

        for (appWidgetId in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.common_comm_widget)

            views.setOnClickPendingIntent(
                R.id.widget_btn_chat,
                deepLinkIntent(context, "commoncomm://chats", appWidgetId * 10 + 1)
            )
            views.setOnClickPendingIntent(
                R.id.widget_btn_tickets,
                deepLinkIntent(context, "commoncomm://tickets", appWidgetId * 10 + 2)
            )
            views.setOnClickPendingIntent(
                R.id.widget_btn_team,
                deepLinkIntent(context, "commoncomm://team", appWidgetId * 10 + 3)
            )

            // Show a dot per tile only when there's unread activity in that
            // category. RemoteViews' setViewVisibility is the only knob we
            // get from the widget host — we can't conditionally render
            // child views or update text values without a full re-inflate.
            views.setViewVisibility(
                R.id.widget_dot_chat,
                if (chatsCount > 0) View.VISIBLE else View.GONE
            )
            views.setViewVisibility(
                R.id.widget_dot_tickets,
                if (ticketsCount > 0) View.VISIBLE else View.GONE
            )
            views.setViewVisibility(
                R.id.widget_dot_team,
                if (teamCount > 0) View.VISIBLE else View.GONE
            )

            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }

    // Each button gets a unique requestCode so the system doesn't reuse one
    // PendingIntent for all three (which would route every tap to the same
    // URL). FLAG_IMMUTABLE is required on API 31+.
    private fun deepLinkIntent(context: Context, url: String, requestCode: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            // Open the existing task if the app is already running so we
            // don't stack a fresh copy of MainActivity on top.
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
