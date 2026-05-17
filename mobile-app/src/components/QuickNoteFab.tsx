// Floating action button that opens the Quick Note capture screen.
// Sits above the bottom tab bar (offset by the live tab-bar height so
// edge-to-edge phones don't tuck it under the gesture-nav pill).

import React from "react";
import { Platform, StyleSheet, Text, TouchableOpacity } from "react-native";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "@/theme";
import type { RootStackParamList } from "@/screens/types";

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function QuickNoteFab() {
  const navigation = useNavigation<Nav>();
  const { colors } = useTheme();
  const tabBarHeight = useBottomTabBarHeight();
  return (
    <TouchableOpacity
      style={[
        styles.fab,
        { bottom: tabBarHeight + 16, backgroundColor: colors.green },
      ]}
      onPress={() => navigation.navigate("QuickNote")}
      accessibilityLabel="Quick note"
      activeOpacity={0.8}
    >
      <Text style={styles.glyph}>📝</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 18,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.25,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 3 },
      },
      android: { elevation: 6 },
    }),
  },
  glyph: { fontSize: 24 },
});
