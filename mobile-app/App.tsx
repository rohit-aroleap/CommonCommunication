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
import * as Updates from "expo-updates";

import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { AppDataProvider, useAppData } from "@/data/AppDataContext";
import { LoginScreen } from "@/auth/LoginScreen";
import { ChatsScreen } from "@/screens/ChatsScreen";
import { TicketsScreen } from "@/screens/TicketsScreen";
import { TeamScreen } from "@/screens/TeamScreen";
import { ThreadScreen } from "@/screens/ThreadScreen";
import { CustomerInfoScreen } from "@/screens/CustomerInfoScreen";
import { registerForPushAsync } from "@/notifications/registerForPush";
import { colors } from "@/theme";
import type { RootStackParamList } from "@/screens/types";

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

function TabsNav() {
  // Read live unread counts. AppDataProvider wraps PostAuth (above this
  // navigator) so useAppData is safe to call here. React Navigation
  // re-evaluates options on every render of this component, so the badge
  // number stays in sync with the listeners.
  const { chatsUnreadCount, teamUnreadCount, ticketsCount } = useAppData();
  // Same safe-area pattern the composer uses (v1.117). Setting an explicit
  // tabBarStyle.height overrides React Navigation's default safe-area
  // handling, so we add insets.bottom back in manually. Without this, the
  // bottom tab icons get clipped by the gesture-nav pill on Androids and
  // by the home indicator on iPhones.
  const insets = useSafeAreaInsets();
  return (
    <Tabs.Navigator
      screenOptions={{
        tabBarActiveTintColor: colors.greenDark,
        tabBarInactiveTintColor: colors.muted,
        headerStyle: { backgroundColor: colors.greenDark },
        headerTintColor: "white",
        headerTitleStyle: { fontWeight: "600" },
        headerRight: () => <LogoutButton />,
        tabBarBadgeStyle: { fontSize: 10, fontWeight: "600" },
        // Bold active label so the active tab also reads strongly via text.
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        // Slightly taller tab bar to fit the pill background comfortably,
        // plus safe-area inset so it clears the gesture bar.
        tabBarStyle: {
          height: 64 + insets.bottom,
          paddingTop: 6,
          paddingBottom: 8 + insets.bottom,
        },
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
  return (
    <View style={[styles.tabIconWrap, focused && styles.tabIconWrapActive]}>
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
  // Active-tab pill behind the icon. Light green wash against the bottom
  // tab bar's white so it reads at a glance without being loud.
  tabIconWrap: {
    width: 56,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  tabIconWrapActive: {
    backgroundColor: "#d1fae5",
  },
  tabIconTxt: { fontSize: 18 },
  tabIconTxtActive: { fontSize: 20 },
});
