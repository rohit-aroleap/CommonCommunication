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
import { SafeAreaProvider } from "react-native-safe-area-context";
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
      }}
    >
      <Tabs.Screen
        name="Chats"
        component={ChatsScreen}
        options={{
          tabBarIcon: ({ color }) => <TabIcon glyph="💬" color={color} />,
          tabBarBadge: chatsUnreadCount > 0 ? chatsUnreadCount : undefined,
        }}
      />
      <Tabs.Screen
        name="Tickets"
        component={TicketsScreen}
        options={{
          title: "My tickets",
          tabBarLabel: "My tickets",
          tabBarIcon: ({ color }) => <TabIcon glyph="🎫" color={color} />,
          tabBarBadge: ticketsCount > 0 ? ticketsCount : undefined,
        }}
      />
      <Tabs.Screen
        name="Team"
        component={TeamScreen}
        options={{
          title: "Team",
          tabBarLabel: "Team",
          tabBarIcon: ({ color }) => <TabIcon glyph="👥" color={color} />,
          tabBarBadge: teamUnreadCount > 0 ? teamUnreadCount : undefined,
        }}
      />
    </Tabs.Navigator>
  );
}

function TabIcon({ glyph, color }: { glyph: string; color: string }) {
  return (
    <Text style={{ fontSize: 18, color }} accessibilityElementsHidden>
      {glyph}
    </Text>
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
});
