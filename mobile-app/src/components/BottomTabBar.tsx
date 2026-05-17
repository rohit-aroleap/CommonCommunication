// Custom tab bar for the material-top-tab navigator. Material-top-tabs ships
// a pill-style indicator at the top that we can't easily restyle, so we
// render our own bottom bar that matches the look the bottom-tab navigator
// used to render — pill behind the focused icon, emoji glyph, label below,
// red badge for unread counts. Swipe between tabs comes for free from the
// pager-view that material-top-tabs sits on.

import React from "react";
import {
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MaterialTopTabBarProps } from "@react-navigation/material-top-tabs";
import { useTheme } from "@/theme";
import { useAppData } from "@/data/AppDataContext";

const TAB_GLYPH: Record<string, string> = {
  Chats: "💬",
  Tickets: "🎫",
  Team: "👥",
};

const TAB_LABEL: Record<string, string> = {
  Chats: "Chats",
  Tickets: "My tickets",
  Team: "Team",
};

export function BottomTabBar({ state, navigation }: MaterialTopTabBarProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { chatsUnreadCount, ticketsCount, teamUnreadCount } = useAppData();
  const badgeByRoute: Record<string, number> = {
    Chats: chatsUnreadCount,
    Tickets: ticketsCount,
    Team: teamUnreadCount,
  };

  return (
    <View
      style={[
        styles.bar,
        {
          height: 64 + insets.bottom,
          paddingBottom: 8 + insets.bottom,
          backgroundColor: colors.panel,
          borderTopColor: colors.border,
        },
      ]}
    >
      {state.routes.map((route, i) => {
        const focused = state.index === i;
        const badge = badgeByRoute[route.name] || 0;
        const onPress = () => {
          // Same emit-then-navigate dance React Navigation does internally
          // for taps. Pressing the already-focused tab is a no-op so a
          // mistap doesn't reset scroll/state.
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };
        return (
          <TouchableWithoutFeedback
            key={route.key}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            accessibilityLabel={TAB_LABEL[route.name] || route.name}
          >
            <View style={styles.item}>
              <View
                style={[
                  styles.iconWrap,
                  focused && { backgroundColor: colors.pillActiveBg },
                ]}
              >
                <Text
                  style={[styles.iconTxt, focused && styles.iconTxtActive]}
                  accessibilityElementsHidden
                >
                  {TAB_GLYPH[route.name] || "•"}
                </Text>
                {badge > 0 && (
                  <View style={[styles.badge, { backgroundColor: colors.red }]}>
                    <Text style={styles.badgeTxt}>
                      {badge > 99 ? "99+" : String(badge)}
                    </Text>
                  </View>
                )}
              </View>
              <Text
                style={[
                  styles.label,
                  { color: focused ? colors.green : colors.muted },
                ]}
                numberOfLines={1}
              >
                {TAB_LABEL[route.name] || route.name}
              </Text>
            </View>
          </TouchableWithoutFeedback>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
  },
  item: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  iconWrap: {
    width: 56,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  iconTxt: { fontSize: 18 },
  iconTxtActive: { fontSize: 20 },
  label: {
    fontSize: 11,
    fontWeight: "600",
  },
  // Red unread bubble in the top-right of the icon pill. Background color
  // is themed via inline style (light = #ef4444, dark = same red — palette
  // sets colors.red for both).
  badge: {
    position: "absolute",
    top: -2,
    right: 6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeTxt: {
    color: "white",
    fontSize: 10,
    fontWeight: "600",
  },
});
