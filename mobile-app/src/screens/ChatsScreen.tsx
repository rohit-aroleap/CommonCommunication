// Chats tab. Filter + search across all visible chat rows, then render the
// list. The filter rules (daily-groups hidden by default, status/stage
// exclusions) match mobile.html exactly.

import React, { useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "@/theme";
import { useAppData, isDailyGroup } from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { ChatRowItem } from "@/components/ChatRow";
import { FilterBar } from "@/components/FilterBar";
import { DAILY_SENTINEL } from "@/types";
import { FERRA_TAG_STAGE } from "@/config";
import { normalizeFerraPhone } from "@/lib/ferra";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "@/screens/types";

// ChatsScreen lives inside the tab navigator but pushes to the root stack's
// Thread route. Using useNavigation typed against the stack avoids the
// "tab screen but used as stack" prop mismatch.
type Nav = NativeStackNavigationProp<RootStackParamList>;

export function ChatsScreen() {
  const navigation = useNavigation<Nav>();
  const { isAdmin } = useAuth();
  const {
    chatRows,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
    tickets,
    sharedSubsByPhone,
    myLastSeen,
  } = useAppData();
  const { user } = useAuth();

  const [statusFilter, setStatusFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [search, setSearch] = useState("");

  const myUid = user?.uid;

  const myTicketChatKeys = useMemo(() => {
    const out = new Set<string>();
    if (!myUid) return out;
    for (const t of Object.values(tickets)) {
      if (!t || t.status !== "open" || t.assignee !== myUid || !t.anchorChatId)
        continue;
      // encodeKey is mirrored here so we don't import it just for this loop.
      out.add(String(t.anchorChatId).replace(/[.#$\[\]\/]/g, "_"));
    }
    return out;
  }, [tickets, myUid]);

  const enriched = useMemo(
    () =>
      chatRows.map((r) => ({
        row: r,
        name: resolveDisplayName(
          r.phone,
          r.explicitName,
          { chatType: r.chatType, groupName: r.groupName },
          {
            habitUsers,
            cancelledUsers,
            ferraIndex,
            contacts,
          },
        ),
      })),
    [chatRows, habitUsers, cancelledUsers, ferraIndex, contacts],
  );

  const filtered = useMemo(() => {
    let rows = enriched;
    if (!isAdmin) rows = rows.filter((r) => !r.row.private);

    // Daily-workout cohort groups: only visible when explicitly picked.
    if (statusFilter === DAILY_SENTINEL) {
      rows = rows.filter((r) => isDailyGroup(r.row));
    } else {
      rows = rows.filter((r) => !isDailyGroup(r.row));
      if (statusFilter) {
        rows = rows.filter(
          (r) =>
            ferraIndex.phoneToStatus[normalizeFerraPhone(r.row.phone)] ===
            statusFilter,
        );
      }
      if (stageFilter) {
        rows = rows.filter((r) => {
          const tag = sharedSubsByPhone?.[normalizeFerraPhone(r.row.phone)];
          return !!tag && FERRA_TAG_STAGE[tag] === stageFilter;
        });
      }
    }

    const q = search.trim().toLowerCase();
    if (q) {
      const qDigits = q.replace(/\D/g, "");
      rows = rows.filter((r) => {
        if (r.name.toLowerCase().includes(q)) return true;
        if (qDigits && r.row.phone.includes(qDigits)) return true;
        return false;
      });
    }
    return rows;
  }, [
    enriched,
    isAdmin,
    statusFilter,
    stageFilter,
    search,
    ferraIndex,
    sharedSubsByPhone,
  ]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <FilterBar
        rows={chatRows}
        phoneToStatus={ferraIndex.phoneToStatus}
        statusFilter={statusFilter}
        stageFilter={stageFilter}
        search={search}
        onChangeStatus={setStatusFilter}
        onChangeStage={setStageFilter}
        onChangeSearch={setSearch}
      />
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.row.chatKey}
        renderItem={({ item }) => {
          const r = item.row;
          const tag = sharedSubsByPhone?.[normalizeFerraPhone(r.phone)];
          const stage = tag ? FERRA_TAG_STAGE[tag] ?? null : null;
          const status =
            ferraIndex.phoneToStatus[normalizeFerraPhone(r.phone)] ?? null;
          const openTickets = Object.values(tickets).filter(
            (t) =>
              t &&
              t.status === "open" &&
              String(t.anchorChatId || "").replace(/[.#$\[\]\/]/g, "_") ===
                r.chatKey,
          );
          const hasOpenTicket = openTickets.length > 0;
          const myTicket = myTicketChatKeys.has(r.chatKey);
          const lastSeen = myLastSeen[r.chatKey] || 0;
          const unread = r.lastMsgAt > lastSeen && r.direction === "in";

          return (
            <ChatRowItem
              row={r}
              name={item.name}
              subscriptionStatus={status}
              stage={stage}
              hasOpenTicket={hasOpenTicket}
              myTicket={myTicket}
              unread={unread}
              onPress={() =>
                navigation.navigate("Thread", {
                  chatKey: r.chatKey,
                  initialTitle: item.name,
                })
              }
            />
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTxt}>No chats match.</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.panel },
  empty: { padding: 60, alignItems: "center" },
  emptyTxt: { color: colors.muted, fontSize: 14 },
});
