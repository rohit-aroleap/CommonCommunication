// My-tickets tab. Lists every open ticket where assignee === current user.
// Tapping a row pushes the thread for that ticket's chat. Mirrors the
// PWA's #ticketList exactly.

import React, { useMemo } from "react";
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, space } from "@/theme";
import { useAppData, myOpenTickets } from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { formatTime } from "@/lib/format";
import { encodeKey } from "@/lib/encodeKey";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "@/screens/types";

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function TicketsScreen() {
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const {
    tickets,
    chatMetaByKey,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
  } = useAppData();

  const mine = useMemo(
    () => myOpenTickets(tickets, user?.uid),
    [tickets, user?.uid],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <FlatList
        data={mine}
        keyExtractor={(t) => t.id}
        renderItem={({ item: t }) => {
          const chatKey = encodeKey(t.anchorChatId);
          const meta = chatMetaByKey[chatKey] || {};
          const chatType =
            meta.chatType ||
            (String(t.anchorChatId).endsWith("@g.us") ? "group" : "user");
          const name = resolveDisplayName(
            meta.phone || "",
            meta.contactName || meta.displayName,
            { chatType, groupName: meta.groupName },
            { habitUsers, cancelledUsers, ferraIndex, contacts },
          );
          return (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.6}
              onPress={() =>
                navigation.navigate("Thread", {
                  chatKey,
                  initialTitle: name,
                })
              }
            >
              <View style={styles.top}>
                <Text style={styles.title} numberOfLines={1}>
                  {t.title || "(no title)"}
                </Text>
                <Text style={styles.time}>{formatTime(t.createdAt)}</Text>
              </View>
              <Text style={styles.customer} numberOfLines={1}>
                💬 {name}
              </Text>
              <Text style={styles.from}>From: {t.createdByName || "—"}</Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTxt}>
              No open tickets assigned to you. 🎉
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.panel },
  row: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  top: {
    flexDirection: "row",
    alignItems: "baseline",
    marginBottom: 4,
    gap: 8,
  },
  title: { fontSize: 15, fontWeight: "500", color: colors.text, flex: 1 },
  time: { fontSize: 11, color: colors.muted },
  customer: {
    fontSize: 13,
    color: colors.greenDark,
    fontWeight: "500",
    marginBottom: 2,
  },
  from: { fontSize: 12, color: colors.muted },
  empty: { padding: 60, alignItems: "center" },
  emptyTxt: { color: colors.muted, fontSize: 14, textAlign: "center" },
});
