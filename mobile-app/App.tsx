// App root: auth gate → top tabs rendered at the bottom (Chats / Tickets /
// Team) with a stack on top for the Thread screen. Registers for push
// notifications once on sign-in.
//
// v1.193: restored @react-navigation/material-top-tabs after the v1.192
// EAS build shipped the bundled react-native-pager-view native module on
// both iOS and Android. Trainers can swipe horizontally between tabs
// again (WhatsApp pattern). The bottom bar still drives tap-to-tab via
// the custom BottomTabBar.
//
// History: v1.190 had to revert to bottom-tabs because the old iOS
// binary (pre-b25cbb4) didn't have RNCViewPager in its native side and
// crashed on every render. v1.192's EAS Build re-bundled that module so
// the JS swap is safe again.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { refreshFerraNow } from "@/lib/worker";
import {
  kickProcessor as kickSaProcessor,
  retryAllNow,
} from "@/lib/saTranscriptionQueue";
import NetInfo from "@react-native-community/netinfo";
// v1.253: app-wide keep-awake. Trainer asked for the screen to stay on
// across all CommonComm screens, not just the SA recorder. Useful for
// long shifts where the tablet sits on a stand — chat list / customer
// info / team DMs all stay readable without the trainer having to tap
// the screen every 30 seconds. Cost: screen is always on while the app
// is foregrounded (tablet should stay plugged in for long shifts;
// trainer can manually power off via the hardware button when they're
// done).
import { useKeepAwake } from "expo-keep-awake";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  NavigationContainer,
  getFocusedRouteNameFromRoute,
  useNavigation,
  type LinkingOptions,
  type RouteProp,
} from "@react-navigation/native";
import { createMaterialTopTabNavigator } from "@react-navigation/material-top-tabs";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";

import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { AppDataProvider, useAppData } from "@/data/AppDataContext";
import { useWidgetSync } from "@/hooks/useWidgetSync";
import { LoginScreen } from "@/auth/LoginScreen";
import { ChatsScreen } from "@/screens/ChatsScreen";
import { TicketsScreen } from "@/screens/TicketsScreen";
import { TeamScreen } from "@/screens/TeamScreen";
import { MeetingsScreen } from "@/screens/MeetingsScreen";
import { CallScreen } from "@/screens/CallScreen";
import { IncomingCallOverlay } from "@/components/IncomingCallOverlay";
import { ThreadScreen } from "@/screens/ThreadScreen";
import { CustomerInfoScreen } from "@/screens/CustomerInfoScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { BottomTabBar } from "@/components/BottomTabBar";
import { registerForPushAsync } from "@/notifications/registerForPush";
import { registerBackgroundNotificationTaskAsync } from "@/notifications/backgroundNotificationTask";
import {
  registerForegroundCallEventListener,
  setCallNavigator,
  consumeInitialCallNotification,
  takePendingCallAction,
} from "@/notifications/callEvents";
import { getDisplayVersion } from "@/lib/version";
import { ThemeProvider, useTheme } from "@/theme";
import type { RootStackParamList } from "@/screens/types";

// Deep links from the home-screen widget land here. The widget opens URLs
// like `commoncomm://chats`, `commoncomm://tickets`, or `commoncomm://team`;
// React Navigation resolves the path to the right tab inside the Tabs
// navigator. Paths are kept lowercase to match the iOS widgetURL strings.
const deepLinking: LinkingOptions<RootStackParamList> = {
  prefixes: ["commoncomm://"],
  config: {
    screens: {
      Tabs: {
        screens: {
          Chats: "chats",
          Tickets: "tickets",
          Team: "team",
        },
      },
      Thread: "thread/:chatKey",
      CustomerInfo: "customer/:chatKey",
      Settings: "settings",
    },
  },
};

const Tabs = createMaterialTopTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_TITLE: Record<string, string> = {
  Chats: "Chats",
  Tickets: "My tickets",
  Team: "Team",
};

function LogoutButton() {
  const { signOut, user } = useAuth();
  const email = user?.email ?? "your account";
  return (
    <TouchableOpacity
      accessibilityLabel="Log out"
      onPress={() =>
        // Confirmation step so a misfire doesn't kick the trainer back to the
        // sign-in screen mid-conversation. Sign-out itself is fast and the
        // app's AuthGate handles the re-render to LoginScreen.
        Alert.alert(
          "Log out?",
          `Sign out of CommonCommunication (${email})?`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Log out",
              style: "destructive",
              onPress: () => signOut().catch(() => {}),
            },
          ],
        )
      }
      style={styles.logoutBtn}
      hitSlop={8}
    >
      <Text style={styles.logoutBtnTxt}>⏏</Text>
    </TouchableOpacity>
  );
}

// v1.133: gear icon in every tab header that pushes the Settings screen onto
// the root stack. Settings currently holds the per-user Groq API key for
// fast voice-note transcription.
//
// v1.212: added a ↻ Ferra-refresh pill to the left of the gear. Mirrors the
// desktop's ↻ button — tap to force the Ferra-sync worker to pull fresh
// subscription / habit data into Firebase. Shows "30m ago" (or similar
// truncated form) under the icon so trainers can see at a glance how
// stale the customer list / stages they're looking at are.
function HeaderRight() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { ferraLastSyncedAt } = useAppData();
  const [syncing, setSyncing] = useState(false);
  // Tick state used purely to force a re-render once a minute so the
  // "30m ago" label stays current without the trainer reloading. The
  // value is irrelevant — its existence in the closure forces the
  // component to re-run formatRelativeTime() on each tick.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const onPressRefresh = async () => {
    if (syncing) return;
    setSyncing(true);
    const { ok } = await refreshFerraNow();
    setSyncing(false);
    if (!ok) {
      Alert.alert(
        "Ferra refresh failed",
        "Couldn't reach the Ferra-sync worker. Try again in a few seconds — if it keeps failing, the worker may be down.",
      );
    }
    // On success: nothing to do. The Firebase onValue subscription in
    // AppDataContext will pick up the new uploadedAt within a second or
    // two and the pill's "Just now" / "1m ago" label updates itself.
  };

  return (
    <View style={styles.headerRight}>
      <TouchableOpacity
        accessibilityLabel="Refresh Ferra data now"
        onPress={onPressRefresh}
        style={styles.ferraBtn}
        hitSlop={6}
        disabled={syncing}
      >
        {syncing ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <Text style={styles.ferraIcon}>↻</Text>
        )}
        <Text style={styles.ferraAge} numberOfLines={1}>
          {syncing
            ? "syncing…"
            : ferraLastSyncedAt
              ? formatRelativeTime(ferraLastSyncedAt)
              : "—"}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityLabel="Settings"
        onPress={() => nav.navigate("Settings")}
        style={styles.gearBtn}
        hitSlop={8}
      >
        <Text style={styles.gearTxt}>⚙</Text>
      </TouchableOpacity>
      <LogoutButton />
    </View>
  );
}

// v1.212: WhatsApp-ish truncated relative time. "Just now" for < 60s,
// "Nm" for < 60m, "Nh" for < 24h, "Nd" for older. Kept short so the pill
// stays narrow in the header — full timestamp would crowd out the gear.
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now"; // clock drift safety
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  // Beyond a month, the timestamp itself isn't useful for staleness
  // judgment — show ">30d" so it's obvious the auto-sync stopped.
  return ">30d";
}

function TabsNav() {
  // Read live unread counts to keep the iOS app-icon badge in sync.
  // The tab bar itself reads from AppDataContext directly (see
  // BottomTabBar.tsx), so we don't have to pass them down.
  const { chatsUnreadCount, teamUnreadCount } = useAppData();
  // iOS app-icon badge count. Android handles this automatically via the
  // notification tray; iOS only shows a number if the app explicitly sets
  // it. Sum the unread Chats + Team counts (NOT ticketsCount — that's a
  // workload reminder, doesn't represent unread). Resets to 0 when no
  // unread, which clears the red bubble on the home screen.
  useEffect(() => {
    const total = chatsUnreadCount + teamUnreadCount;
    Notifications.setBadgeCountAsync(total).catch(() => {});
  }, [chatsUnreadCount, teamUnreadCount]);
  // Android home-screen widget dot indicators (v1.139). Pushes the same
  // three counts above through the WidgetUpdater native module whenever
  // they change — the widget redraws within a second with a pink dot on
  // each tile that has activity. No-op on iOS (separate WidgetKit work).
  useWidgetSync();
  return (
    <Tabs.Navigator
      tabBarPosition="bottom"
      tabBar={(props) => <BottomTabBar {...props} />}
      // Pager-view swipe is enabled by default. Keep all three screens
      // mounted (lazy: false) so the swipe-in animation slides the real
      // content in instead of a blank pane that then mounts mid-gesture.
      screenOptions={{
        swipeEnabled: true,
        lazy: false,
        // Hide the default top indicator bar — BottomTabBar handles the
        // active-state visual entirely.
        tabBarIndicatorStyle: { height: 0 },
      }}
    >
      <Tabs.Screen name="Chats" component={ChatsScreen} />
      <Tabs.Screen name="Tickets" component={TicketsScreen} />
      <Tabs.Screen name="Team" component={TeamScreen} />
      {/* v1.256: Meetings tab — mirrors the web's meetings feature for
          on-the-go recording. Mobile uses single-file upload (no chunking)
          so the practical recording cap is ~3 hr / 25 MB. */}
      <Tabs.Screen name="Meetings" component={MeetingsScreen} />
    </Tabs.Navigator>
  );
}

// TabsHeaderTitle — Stack header re-renders on tab change because the route
// state updates; we read the currently-focused tab name and render the
// matching title. Chats gets the version chip alongside it, same as before
// — trainers use it to read back the running build in support chats.
function TabsHeaderTitle({
  route,
}: {
  route: RouteProp<RootStackParamList, "Tabs">;
}) {
  const { colors } = useTheme();
  const focused = getFocusedRouteNameFromRoute(route) ?? "Chats";
  const title = TAB_TITLE[focused] || focused;
  const titleStyle = [styles.headerTitleTxt, { color: colors.headerText }];
  if (focused === "Chats") {
    return (
      <View style={styles.headerTitleRow}>
        <Text style={titleStyle}>{title}</Text>
        <Text style={[styles.headerTitleVer, { color: colors.headerText, opacity: 0.6 }]}>
          {getDisplayVersion()}
        </Text>
      </View>
    );
  }
  return <Text style={titleStyle}>{title}</Text>;
}

// v1.268: bridges Notifee call events into React Navigation. Mounted
// inside the NavigationContainer so it can call navigation.navigate
// safely. Handles three sources of "go to Call screen for this id":
//   1. Foreground Notifee event (Accept tapped while app open).
//   2. Background pending action (Accept tapped while killed/bg —
//      stashed by callEvents.ts, consumed here on next foreground).
//   3. Initial notification (app cold-started by tapping the call
//      notification — consumed once at mount).
function CallEventsBridge() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  useEffect(() => {
    const navigateToCall = (callId: string) => {
      navigation.navigate("Call", { callId });
    };
    setCallNavigator(navigateToCall);

    // 1. Foreground events — Accept/Decline/body tap while app is open.
    const unsubFg = registerForegroundCallEventListener();

    // 2. Pending bg action — pulled the moment we mount; may be null.
    const pending = takePendingCallAction();
    if (pending && pending.callId) {
      // 60s grace — older entries are stale and we ignore them.
      if (Date.now() - pending.at < 60_000) {
        navigateToCall(pending.callId);
      }
    }

    // 3. Initial notification — only fires once per cold start.
    void consumeInitialCallNotification().then((init) => {
      if (init?.callId) navigateToCall(init.callId);
    });

    return () => {
      unsubFg();
      setCallNavigator(null);
    };
  }, [navigation]);

  return null;
}

function PostAuth() {
  const { user } = useAuth();
  const { colors } = useTheme();
  useEffect(() => {
    if (!user) return;
    registerForPushAsync(user.uid).catch((e) =>
      console.warn("[push] register failed:", e),
    );
    // v1.268: register the Expo background notification task once
    // we have a signed-in user. The task itself was defined at
    // module-load via index.ts; this call tells the OS to actually
    // route data pushes to it. Idempotent.
    registerBackgroundNotificationTaskAsync().catch((e) =>
      console.warn("[bg-notif] register failed:", e),
    );
  }, [user]);
  return (
    <AppDataProvider>
      <NavigationContainer linking={deepLinking}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.header },
            headerTintColor: colors.headerText,
          }}
        >
          <Stack.Screen
            name="Tabs"
            component={TabsNav}
            options={({ route }) => ({
              headerTitle: () => <TabsHeaderTitle route={route} />,
              headerRight: () => <HeaderRight />,
              headerStyle: { backgroundColor: colors.header },
              headerTintColor: colors.headerText,
              headerTitleStyle: { fontWeight: "600" },
            })}
          />
          <Stack.Screen
            name="Thread"
            component={ThreadScreen}
            options={{ headerBackTitleVisible: false }}
          />
          <Stack.Screen
            name="CustomerInfo"
            component={CustomerInfoScreen}
            options={{ title: "Customer info", headerBackTitleVisible: false }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: "Settings", headerBackTitleVisible: false }}
          />
          {/* v1.264: 1:1 audio call screen. headerShown=false so the
              call UI takes the whole screen. */}
          <Stack.Screen
            name="Call"
            component={CallScreen}
            options={{ headerShown: false, gestureEnabled: false }}
          />
        </Stack.Navigator>
        {/* v1.264: incoming-call overlay. Mounted INSIDE the
            NavigationContainer so it can navigate to the Call screen,
            but OUTSIDE the Stack.Navigator so it covers any screen.
            v1.268: now coexists with the Notifee call notification —
            when the app is foregrounded with no notification (e.g.
            ring happened while the app was already open and the
            background task wasn't needed), this overlay is the
            primary UI. When the notification is showing, this stays
            suppressed because Notifee's full-screen intent has
            already taken over. */}
        <IncomingCallOverlay />
        {/* v1.268: bridges Notifee accept/decline events into the
            navigator. Must be inside NavigationContainer. */}
        <CallEventsBridge />
      </NavigationContainer>
    </AppDataProvider>
  );
}

function Gate() {
  const { status } = useAuth();
  const { colors } = useTheme();
  if (status === "loading") {
    return (
      <View style={[styles.loading, { backgroundColor: colors.header }]}>
        <ActivityIndicator color={colors.green} />
      </View>
    );
  }
  if (status === "signed-in") return <PostAuth />;
  return <LoginScreen />;
}

// EAS Update / OTA: on cold start AND on every foreground transition, check
// the Update server for a newer JS bundle. If one is available, fetch it and
// reload silently. Dev builds skip the check (expo-updates is no-op in dev).
function useOtaUpdates() {
  useEffect(() => {
    if (__DEV__) return;
    async function check() {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (!result.isAvailable) return;
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
      } catch (e) {
        // Silent: missing OTA config in dev / no network / etc. shouldn't
        // crash the app. The user just keeps running the embedded bundle.
      }
    }
    check();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => sub.remove();
  }, []);
}

// v1.249: kick the SA transcription queue processor on app start and every
// time the app returns to foreground. The queue persists in AsyncStorage,
// so a tablet that recorded an SA while offline (or that was killed mid-
// upload) resumes the upload attempts as soon as the app + network are
// available. Cheap to call — the processor itself no-ops if the queue is
// empty or another tick is already running.
function useSaQueueProcessor() {
  useEffect(() => {
    kickSaProcessor();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") kickSaProcessor();
    });
    // v1.296: when connectivity is restored, bypass each item's backoff
    // and retry immediately. Previously a stuck upload (e.g. "Retry 7",
    // 30-min backoff) would sit idle even after wifi came back — the
    // processor only fired on its slow timer. NetInfo's reachability
    // transition false/null -> true triggers retryAllNow. Tracks the
    // previous state so we only fire on the rising edge, not every event.
    let wasOnline: boolean | null = null;
    const netSub = NetInfo.addEventListener((s) => {
      const online = !!s.isConnected && s.isInternetReachable !== false;
      if (online && wasOnline === false) {
        void retryAllNow();
      }
      wasOnline = online;
    });
    return () => {
      sub.remove();
      netSub();
    };
  }, []);
}

export default function App() {
  useOtaUpdates();
  useSaQueueProcessor();
  // v1.253: hold the screen-on lock for the entire app lifetime. The hook
  // activates on mount and releases when App unmounts (= app process
  // dies). Net effect: while CommonComm is foregrounded, screen never
  // auto-locks. Backgrounding the app doesn't matter — Android's normal
  // foreground app gets the screen anyway.
  useKeepAwake();
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedApp />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

// Inside ThemeProvider so it can read the current header color for the
// status bar tint. The status bar is "light" content (icons + clock white)
// in both themes since the header is always darker than the chrome behind.
function ThemedApp() {
  const { colors } = useTheme();
  return (
    <>
      <StatusBar style="light" backgroundColor={colors.header} />
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    // backgroundColor injected by Gate() via inline style — depends on theme.
  },
  logoutBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: 8,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  logoutBtnTxt: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
    transform: [{ rotate: "90deg" }],
  },
  // v1.133: header right cluster — gear + logout. Wrapped in a flex row so the
  // two buttons sit side-by-side without extra padding tricks.
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
  },
  gearBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: 4,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  gearTxt: {
    color: "white",
    fontSize: 18,
  },
  // v1.212: Ferra refresh pill. Wider than the gear because it has two
  // stacked rows — the ↻ glyph and the "30m ago" label. Same translucent
  // chip background as the gear/logout so the three buttons read as a
  // unit. Slight extra right margin pushes the gear away by 4px more
  // than the default so the pill doesn't crowd it.
  ferraBtn: {
    minWidth: 56,
    height: 36,
    paddingHorizontal: 8,
    borderRadius: 14,
    marginRight: 6,
    backgroundColor: "rgba(255,255,255,0.18)",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  ferraIcon: {
    color: "white",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 16,
  },
  ferraAge: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 9,
    lineHeight: 11,
    marginTop: 1,
  },
  headerTitleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
  },
  headerTitleTxt: {
    fontSize: 17,
    fontWeight: "600",
  },
  headerTitleVer: {
    fontSize: 11,
    fontWeight: "400",
  },
});
