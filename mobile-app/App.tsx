// App root: auth gate → bottom tabs (Chats / Tickets) with a stack on top
// for the Thread screen. Registers for push notifications once on sign-in.

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
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";

import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { AppDataProvider, useAppData } from "@/data/AppDataContext";
import { useWidgetSync } from "@/hooks/useWidgetSync";
import { LoginScreen } from "@/auth/LoginScreen";
import { ChatsScreen } from "@/screens/ChatsScreen";
import { TicketsScreen } from "@/screens/TicketsScreen";
import { TeamScreen } from "@/screens/TeamScreen";
import { ThreadScreen } from "@/screens/ThreadScreen";
import { CustomerInfoScreen } from "@/screens/CustomerInfoScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { registerForPushAsync } from "@/notifications/registerForPush";
import { ThemeProvider, useTheme } from "@/theme";
import type { RootStackParamList } from "@/screens/types";
import type { LinkingOptions } from "@react-navigation/native";

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

const Tabs = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

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
function HeaderRight() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <View style={styles.headerRight}>
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

function TabsNav() {
  // Read live unread counts. AppDataProvider wraps PostAuth (above this
  // navigator) so useAppData is safe to call here. React Navigation
  // re-evaluates options on every render of this component, so the badge
  // number stays in sync with the listeners.
  const { chatsUnreadCount, teamUnreadCount, ticketsCount } = useAppData();
  const { colors } = useTheme();
  // Same safe-area pattern the composer uses (v1.117). Setting an explicit
  // tabBarStyle.height overrides React Navigation's default safe-area
  // handling, so we add insets.bottom back in manually. Without this, the
  // bottom tab icons get clipped by the gesture-nav pill on Androids and
  // by the home indicator on iPhones.
  const insets = useSafeAreaInsets();
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
      screenOptions={{
        // v1.136: in dark mode greenDark is near-black slate — tabs in the
        // bottom bar would disappear into the bg. Use `green` (the brand
        // accent: emerald in light, blue in dark) for the active tab tint
        // and bg, falling back to muted for inactive.
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          height: 64 + insets.bottom,
          paddingTop: 6,
          paddingBottom: 8 + insets.bottom,
          backgroundColor: colors.panel,
          borderTopColor: colors.border,
        },
        headerStyle: { backgroundColor: colors.header },
        headerTintColor: colors.headerText,
        headerTitleStyle: { fontWeight: "600" },
        headerRight: () => <HeaderRight />,
        tabBarBadgeStyle: { fontSize: 10, fontWeight: "600" },
        // Bold active label so the active tab also reads strongly via text.
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="Chats"
        component={ChatsScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabIcon glyph="💬" focused={focused} />,
          tabBarBadge: chatsUnreadCount > 0 ? chatsUnreadCount : undefined,
        }}
      />
      <Tabs.Screen
        name="Tickets"
        component={TicketsScreen}
        options={{
          title: "My tickets",
          tabBarLabel: "My tickets",
          tabBarIcon: ({ focused }) => <TabIcon glyph="🎫" focused={focused} />,
          tabBarBadge: ticketsCount > 0 ? ticketsCount : undefined,
        }}
      />
      <Tabs.Screen
        name="Team"
        component={TeamScreen}
        options={{
          title: "Team",
          tabBarLabel: "Team",
          tabBarIcon: ({ focused }) => <TabIcon glyph="👥" focused={focused} />,
          tabBarBadge: teamUnreadCount > 0 ? teamUnreadCount : undefined,
        }}
      />
    </Tabs.Navigator>
  );
}

// TabIcon — wraps the emoji in a pill background when the tab is focused.
// Emojis ignore the `color` prop (they render in their native colors), so
// we can't rely on tint to show active vs inactive. The pill + scale-up +
// label color difference together give a strong visual signal.
function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.tabIconWrap,
        focused && { backgroundColor: colors.pillActiveBg },
      ]}
    >
      <Text
        style={[styles.tabIconTxt, focused && styles.tabIconTxtActive]}
        accessibilityElementsHidden
      >
        {glyph}
      </Text>
    </View>
  );
}

function PostAuth() {
  const { user } = useAuth();
  const { colors } = useTheme();
  useEffect(() => {
    if (!user) return;
    registerForPushAsync(user.uid).catch((e) =>
      console.warn("[push] register failed:", e),
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
            options={{ headerShown: false }}
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
        </Stack.Navigator>
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

export default function App() {
  useOtaUpdates();
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
  // Active-tab pill behind the icon. Background color is themed via inline
  // style (TabIcon reads colors.pillActiveBg from useTheme).
  tabIconWrap: {
    width: 56,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  tabIconTxt: { fontSize: 18 },
  tabIconTxtActive: { fontSize: 20 },
});
