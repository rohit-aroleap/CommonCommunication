// Home-screen App Widget for CommonComm. Renders three shortcut buttons
// (Chat, My tickets, Team) that each fire a deep link into the React
// Native app via the `commoncomm://` scheme. React Navigation's `linking`
// config resolves the path to the matching tab.
//
// Static widget — no data, no AppWidgetService — so onUpdate just rebuilds
// the RemoteViews with the right PendingIntents and pushes it to every
// active widget instance.

package com.aroleap.commoncomm.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import com.aroleap.commoncomm.R

class CommonCommWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
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
