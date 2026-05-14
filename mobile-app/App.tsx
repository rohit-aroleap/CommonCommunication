// App root: auth gate → bottom tabs (Chats / Tickets) with a stack on top
// for the Thread screen. Registers for push notifications once on sign-in.

import React, { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { AppDataProvider } from "@/data/AppDataContext";
import { LoginScreen } from "@/auth/LoginScreen";
import { ChatsScreen } from "@/screens/ChatsScreen";
import { TicketsScreen } from "@/screens/TicketsScreen";
import { ThreadScreen } from "@/screens/ThreadScreen";
import { registerForPushAsync } from "@/notifications/registerForPush";
import { colors } from "@/theme";
import type { RootStackParamList } from "@/screens/types";

const Tabs = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

function TabsNav() {
  return (
    <Tabs.Navigator
      screenOptions={{
        tabBarActiveTintColor: colors.greenDark,
        tabBarInactiveTintColor: colors.muted,
        headerStyle: { backgroundColor: colors.greenDark },
        headerTintColor: "white",
        headerTitleStyle: { fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="Chats"
        component={ChatsScreen}
        options={{
          tabBarIcon: ({ color }) => <TabIcon glyph="💬" color={color} />,
        }}
      />
      <Tabs.Screen
        name="Tickets"
        component={TicketsScreen}
        options={{
          title: "My tickets",
          tabBarLabel: "My tickets",
          tabBarIcon: ({ color }) => <TabIcon glyph="🎫" color={color} />,
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

export default function App() {
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
});
