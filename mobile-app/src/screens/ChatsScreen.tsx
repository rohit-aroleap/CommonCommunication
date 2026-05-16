// Chats tab. Filter + search across all visible chat rows, then render the
// list. The filter rules (daily-groups hidden by default, status/stage
// exclusions) match mobile.html exactly.

import React, { useLayoutEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, space } from "@/theme";
import { useAppData, isDailyGroup } from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { ChatRowItem } from "@/components/ChatRow";
import { FilterBar } from "@/components/FilterBar";
import { DAILY_SENTINEL } from "@/types";
import { FERRA_TAG_STAGE } from "@/config";
import { normalizeFerraPhone } from "@/lib/ferra";
import { shouldSuggestPin } from "@/lib/favorites";
import { getDisplayVersion } from "@/lib/version";
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
    myFavorites,
    mySendActivity,
    toggleFavorite,
  } = useAppData();
  const { user } = useAuth();

  const [statusFilter, setStatusFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [search, setSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  // Render "Chats" with the version chip beside it in the green topbar.
  // Tab navigator headers default to plain text from the tab name;
  // overriding headerTitle with a component lets us add the version next
  // to it so trainers can read it back without scrolling to the footer.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={styles.headerTitleRow}>
          <Text style={styles.headerTitleTxt}>Chats</Text>
          <Text style={styles.headerTitleVer}>{getDisplayVersion()}</Text>
        </View>
      ),
    });
  }, [navigation]);

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

  // Partition: chats with my open ticket anchor the very top, then
  // favorites (without my ticket), then everything else. Tickets are
  // usually more urgent than favorites, so they always sort above them.
  // Within each bucket we keep the existing lastMsgAt sort.
  type ListItem =
    | { kind: "row"; key: string; item: (typeof enriched)[number] }
    | { kind: "divider"; key: string };

  const listData = useMemo<ListItem[]>(() => {
    const tickets: typeof filtered = [];
    const favorites: typeof filtered = [];
    const rest: typeof filtered = [];
    for (const r of filtered) {
      if (myTicketChatKeys.has(r.row.chatKey)) tickets.push(r);
      else if (myFavorites[r.row.chatKey]) favorites.push(r);
      else rest.push(r);
    }
    if (favoritesOnly) {
      return favorites.map((r) => ({
        kind: "row",
        key: r.row.chatKey,
        item: r,
      }));
    }
    const pinned = tickets.concat(favorites);
    const items: ListItem[] = pinned.map((r) => ({
      kind: "row",
      key: r.row.chatKey,
      item: r,
    }));
    if (pinned.length > 0 && rest.length > 0) {
      items.push({ kind: "divider", key: "__divider__" });
    }
    for (const r of rest) {
      items.push({ kind: "row", key: r.row.chatKey, item: r });
    }
    return items;
  }, [filtered, myFavorites, myTicketChatKeys, favoritesOnly]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <FilterBar
        rows={chatRows}
        phoneToStatus={ferraIndex.phoneToStatus}
        statusFilter={statusFilter}
        stageFilter={stageFilter}
        search={search}
        favoritesOnly={favoritesOnly}
        onChangeStatus={setStatusFilter}
        onChangeStage={setStageFilter}
        onChangeSearch={setSearch}
        onChangeFavoritesOnly={setFavoritesOnly}
      />
      <FlatList
        data={listData}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => {
          if (item.kind === "divider") {
            return (
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerTxt}>More chats</Text>
                <View style={styles.dividerLine} />
              </View>
            );
          }
          const enrichedRow = item.item;
          const r = enrichedRow.row;
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
          const isFavorite = !!myFavorites[r.chatKey];
          const suggestPin = shouldSuggestPin(
            r.chatKey,
            myFavorites,
            mySendActivity,
          );

          return (
            <ChatRowItem
              row={r}
              name={enrichedRow.name}
              subscriptionStatus={status}
              stage={stage}
              hasOpenTicket={hasOpenTicket}
              myTicket={myTicket}
              unread={unread}
              isFavorite={isFavorite}
              suggestPin={suggestPin}
              onPress={() =>
                navigation.navigate("Thread", {
                  chatKey: r.chatKey,
                  initialTitle: enrichedRow.name,
                })
              }
              onToggleFavorite={() => toggleFavorite(r.chatKey)}
            />
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTxt}>
              {favoritesOnly ? "No favorites yet." : "No chats match."}
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.versionFooter}>
            <Text style={styles.versionTxt}>{getDisplayVersion()}</Text>
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
  versionFooter: { paddingVertical: 16, alignItems: "center" },
  versionTxt: { color: colors.muted, fontSize: 10 },
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
  divider: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.md,
    paddingVertical: 6,
    backgroundColor: "#f6f7f8",
    gap: space.sm,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  dividerTxt: {
    fontSize: 11,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
