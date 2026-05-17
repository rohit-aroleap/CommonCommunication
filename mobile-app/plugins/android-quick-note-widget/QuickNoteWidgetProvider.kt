// Android home-screen widget for CommonCommunication.
//
// The widget is a tap-target: render a static tile, and on tap fire an
// ACTION_VIEW intent for `commoncomm://quick-note`. Expo's `scheme`
// config registers the matching intent-filter on the launcher activity,
// so the OS routes the tap into the host app, which then runs React
// Navigation's `linking` config and lands on QuickNoteScreen.
//
// updatePeriodMillis is 0 in the widget info XML — we never refresh the
// tile content, so we never schedule a wake-up. onUpdate runs once when
// the widget is placed (and after a reboot, via APPWIDGET_UPDATE).
//
// The package declaration below is rewritten at prebuild time by the
// config plugin (./index.js) to match config.android.package, so this
// file works even if the app gets renamed.

package com.aroleap.commoncomm

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

class QuickNoteWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (appWidgetId in appWidgetIds) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("commoncomm://quick-note")).apply {
                // FLAG_ACTIVITY_NEW_TASK lets the launcher's process hand off
                // to our app's task stack cleanly.
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val pendingIntent = PendingIntent.getActivity(
                context,
                0,
                intent,
                // FLAG_IMMUTABLE is required on Android 12+. UPDATE_CURRENT
                // lets us swap the intent without re-allocating.
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val views = RemoteViews(context.packageName, R.layout.quick_note_widget)
            views.setOnClickPendingIntent(R.id.quick_note_widget_root, pendingIntent)
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
