// Pipes the three unread-badge counts from AppDataContext into the
// Android home-screen widget. Mount this once near the root of the
// signed-in tree (App.tsx PostAuth) — it has no UI, just runs an
// effect that watches the counts and pushes them through the native
// bridge whenever they change.
//
// AppDataContext is the source of truth for these numbers; same values
// the bottom-tab badges and the iOS app-icon badge already use, so the
// widget can't drift from those.

import { useEffect } from "react";
import { useAppData } from "@/data/AppDataContext";
import { setWidgetUnreadCounts } from "@/lib/widgetUpdater";

export function useWidgetSync(): void {
  const { chatsUnreadCount, ticketsCount, teamUnreadCount } = useAppData();

  useEffect(() => {
    setWidgetUnreadCounts(chatsUnreadCount, ticketsCount, teamUnreadCount);
  }, [chatsUnreadCount, ticketsCount, teamUnreadCount]);
}
