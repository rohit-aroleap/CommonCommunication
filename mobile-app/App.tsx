// App root: auth gate → bottom tabs (Chats / Tickets / Team) with a stack on
// top for the Thread screen. Registers for push notifications once on
// sign-in. The tab navigator is material-top-tabs with tabBarPosition
// "bottom" so the trainer can swipe horizontally between tabs (WhatsApp
// pattern) while the bottom bar still drives tap-to-tab.

import React, { useEffect } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  NavigationContainer,
  getFocusedRouteNameFromRoute,
  type RouteProp,
} from "@react-navigation/native";
import { createMaterialTopTabNavigator } from "@react-navigation/material-top-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";

import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { AppDataProvider, useAppData } from "@/data/AppDataContext";
import { LoginScreen } from "@/auth/LoginScreen";
import { ChatsScreen } from "@/screens/ChatsScreen";
import { TicketsScreen } from "@/screens/TicketsScreen";
import { TeamScreen } from "@/screens/TeamScreen";
import { ThreadScreen } from "@/screens/ThreadScreen";
import { CustomerInfoScreen } from "@/screens/CustomerInfoScreen";
import { BottomTabBar } from "@/components/BottomTabBar";
import { registerForPushAsync } from "@/notifications/registerForPush";
import { getDisplayVersion } from "@/lib/version";
import { colors } from "@/theme";
import type { RootStackParamList } from "@/screens/types";

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
  return (
    <Tabs.Navigator
      tabBarPosition="bottom"
      tabBar={(props) => <BottomTabBar {...props} />}
      // Pager-view swipe is enabled by default. Keep all three screens
      // mounted (lazy: false) so the swipe-in animation slides the real
      // content in instead of a blank pane that then mounts mid-gesture.
      // Trainers will use all three tabs in a session anyway, so the
      // memory cost is fine.
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
    </Tabs.Navigator>
  );
}

// TabsHeaderTitle — Stack header re-renders on tab change because the route
// state updates; we read the currently-focused tab name and render the
// matching title. Chats gets the version chip alongside it, same as before
// — trainers use it to read back the running build in support chats.
function TabsHeaderTitle({ route }: { route: RouteProp<RootStackParamList, "Tabs"> }) {
  const focused = getFocusedRouteNameFromRoute(route) ?? "Chats";
  const title = TAB_TITLE[focused] || focused;
  if (focused === "Chats") {
    return (
      <View style={styles.headerTitleRow}>
        <Text style={styles.headerTitleTxt}>{title}</Text>
        <Text style={styles.headerTitleVer}>{getDisplayVersion()}</Text>
      </View>
    );
  }
  return <Text style={styles.headerTitleTxt}>{title}</Text>;
}

function PostAuth() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    registerForPushAsync(user.uid).catch((e) =>
      console.warn("[push] register failed:", e),
    );
  }, [user]);
  return (
    <AppDataProvider>
      <NavigationContainer>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.greenDark },
            headerTintColor: "white",
          }}
        >
          <Stack.Screen
            name="Tabs"
            component={TabsNav}
            options={({ route }) => ({
              headerTitle: () => <TabsHeaderTitle route={route} />,
              headerRight: () => <LogoutButton />,
              headerStyle: { backgroundColor: colors.greenDark },
              headerTintColor: "white",
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
        </Stack.Navigator>
      </NavigationContainer>
    </AppDataProvider>
  );
}

function Gate() {
  const { status } = useAuth();
  if (status === "loading") {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.greenDark} />
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

export default function App() {
  useOtaUpdates();
  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor={colors.greenDark} />
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.greenDark,
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
  headerTitleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
  },
  headerTitleTxt: {
    color: "white",
    fontSize: 17,
    fontWeight: "600",
  },
  headerTitleVer: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "400",
  },
});
