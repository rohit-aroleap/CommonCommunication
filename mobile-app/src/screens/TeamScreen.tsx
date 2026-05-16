// Team tab. Lists every internal DM the current user is a participant in,
// plus a "Start a new chat" row that opens a picker of teammates from
// commonComm/users. Tapping a teammate creates the DM (idempotently) and
// pushes onto the Thread stack with the "dm:" + pairKey route param.
//
// Internal DMs never touch Periscope; the message tree lives at
// commonComm/dms/{pairKey} and Firebase rules restrict reads/writes to the
// two participant uids.

import React, { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ref, set, update, get } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { colors, space } from "@/theme";
import {
  useAppData,
  getPairKey,
  chatKeyFromPairKey,
} from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "@/screens/types";
import type { DmRow, TeamMember, TeamUser } from "@/types";

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function TeamScreen() {
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const { dmRows, teamUsers, teamMembers } = useAppData();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dmRows;
    return dmRows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q),
    );
  }, [dmRows, search]);

  const openDm = async (otherUid: string, displayName: string) => {
    if (!user) return;
    const pairKey = getPairKey(user.uid, otherUid);
    // Idempotent create. The DM exists if its meta does — we only need to
    // write participants once. Doing it on every open is fine since we
    // overwrite with the same value.
    const metaPath = `${ROOT}/dms/${pairKey}/meta`;
    const snap = await get(ref(db, metaPath));
    if (!snap.exists()) {
      await update(ref(db, metaPath), {
        participants: { [user.uid]: true, [otherUid]: true },
        createdAt: Date.now(),
        lastMsgAt: 0,
        lastMsgPreview: "",
      });
    }
    setPickerOpen(false);
    navigation.navigate("Thread", {
      chatKey: chatKeyFromPairKey(pairKey),
      initialTitle: displayName,
    });
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search teammates"
          placeholderTextColor={colors.muted}
        />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(r) => r.chatKey}
        ListHeaderComponent={
          <TouchableOpacity
            style={styles.newRow}
            onPress={() => setPickerOpen(true)}
            activeOpacity={0.6}
          >
            <View style={styles.newIcon}>
              <Text style={styles.newIconTxt}>+</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.newTitle}>Start a new internal chat</Text>
              <Text style={styles.newSub}>
                Pick a teammate — stays inside the dashboard
              </Text>
            </View>
          </TouchableOpacity>
        }
        renderItem={({ item }) => (
          <DmRowItem
            row={item}
            isMe={item.lastMsgFromUid === user?.uid}
            onPress={() =>
              navigation.navigate("Thread", {
                chatKey: item.chatKey,
                initialTitle: item.name,
              })
            }
          />
        )}
        ListEmptyComponent={
          search ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTxt}>No teammates match.</Text>
            </View>
          ) : null
        }
      />
      <PickerModal
        visible={pickerOpen}
        teamUsers={teamUsers}
        teamMembers={teamMembers}
        meUid={user?.uid ?? ""}
        meEmail={user?.email ?? ""}
        onPick={openDm}
        onClose={() => setPickerOpen(false)}
      />
    </SafeAreaView>
  );
}

function DmRowItem({
  row,
  isMe,
  onPress,
}: {
  row: DmRow;
  isMe: boolean;
  onPress: () => void;
}) {
  const initial = (row.name?.[0] || "?").toUpperCase();
  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.6}>
      <View style={styles.avatar}>
        <Text style={styles.avatarTxt}>{initial}</Text>
      </View>
      <View style={styles.col}>
        <View style={styles.topLine}>
          <Text style={styles.name} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={styles.time}>{formatTime(row.lastMsgAt)}</Text>
        </View>
        <View style={styles.bottomLine}>
          <Text
            style={[styles.preview, row.unread && styles.previewUnread]}
            numberOfLines={1}
          >
            {isMe && row.lastMsgFromName ? (
              <Text style={styles.previewWho}>{row.lastMsgFromName}: </Text>
            ) : null}
            {row.preview || "No messages yet"}
          </Text>
          {row.unread && <View style={styles.unreadDot} />}
        </View>
      </View>
    </TouchableOpacity>
  );
}

interface PickerCandidate {
  uid: string | null;
  name: string;
  email: string;
  active: boolean;
}

function PickerModal({
  visible,
  teamUsers,
  teamMembers,
  meUid,
  meEmail,
  onPick,
  onClose,
}: {
  visible: boolean;
  teamUsers: Record<string, TeamUser>;
  teamMembers: Record<string, TeamMember>;
  meUid: string;
  meEmail: string;
  onPick: (uid: string, name: string) => void;
  onClose: () => void;
}) {
  // Two-source merge so configured-but-not-yet-signed-in teammates also
  // appear (greyed out). Source A = teamUsers (signed-in, has uid →
  // DM works). Source B = config/teamMembers (admin-curated roster).
  const candidates = useMemo<PickerCandidate[]>(() => {
    const seen = new Set<string>();
    const out: PickerCandidate[] = [];
    const myEmailLower = meEmail.toLowerCase();
    for (const [uid, u] of Object.entries(teamUsers)) {
      if (uid === meUid) continue;
      const emailLower = String(u?.email || "").toLowerCase();
      if (emailLower) seen.add(emailLower);
      out.push({
        uid,
        name: u?.name || u?.email || "(unknown)",
        email: u?.email || "",
        active: true,
      });
    }
    for (const m of Object.values(teamMembers || {})) {
      if (!m?.email) continue;
      const emailLower = m.email.toLowerCase();
      if (emailLower === myEmailLower) continue;
      if (seen.has(emailLower)) continue;
      out.push({
        uid: null,
        name: m.name || m.email,
        email: m.email,
        active: false,
      });
      seen.add(emailLower);
    }
    out.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [teamUsers, teamMembers, meUid, meEmail]);

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBack} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>Start an internal chat</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.modalClose}>×</Text>
            </TouchableOpacity>
          </View>
          {candidates.length === 0 ? (
            <View style={{ padding: 24 }}>
              <Text style={styles.emptyTxt}>
                No teammates configured yet. Ask an admin to add them via
                the desktop dashboard → 👥 Team.
              </Text>
            </View>
          ) : (
            <FlatList
              data={candidates}
              keyExtractor={(c) => c.uid ?? `email:${c.email}`}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.pickerItem,
                    !item.active && styles.pickerItemInactive,
                  ]}
                  onPress={() => {
                    if (!item.active) {
                      Alert.alert(
                        `${item.name} hasn't signed in yet`,
                        "Ask them to sign in to the dashboard or mobile app once, then they'll show up here as DM-able.",
                      );
                      return;
                    }
                    onPick(item.uid!, item.name);
                  }}
                >
                  <View style={styles.pickerAvatar}>
                    <Text style={styles.pickerAvatarTxt}>
                      {(item.name[0] || "?").toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.pickerNameRow}>
                      <Text style={styles.pickerName}>{item.name}</Text>
                      {!item.active && (
                        <View style={styles.notSignedInBadge}>
                          <Text style={styles.notSignedInTxt}>
                            NOT SIGNED IN
                          </Text>
                        </View>
                      )}
                    </View>
                    {item.email ? (
                      <Text style={styles.pickerEmail}>{item.email}</Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yest = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  const diff = (now.getTime() - d.getTime()) / 86400000;
  if (diff < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

const DM_BLUE = "#3b82f6";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.panel },
  searchRow: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: colors.panel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  search: {
    height: 36,
    backgroundColor: colors.header,
    borderRadius: 8,
    paddingHorizontal: space.md,
    fontSize: 14,
    color: colors.text,
  },
  newRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: "#f8fafc",
    gap: space.md,
  },
  newIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: DM_BLUE,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  newIconTxt: { color: DM_BLUE, fontSize: 24, fontWeight: "300" },
  newTitle: { fontSize: 15, fontWeight: "500", color: "#1e40af" },
  newSub: { fontSize: 12, color: colors.muted, marginTop: 2 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: 64,
    gap: space.md,
    backgroundColor: colors.panel,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: DM_BLUE,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarTxt: { color: "white", fontSize: 18, fontWeight: "500" },
  col: { flex: 1, minWidth: 0, gap: 2 },
  topLine: { flexDirection: "row", alignItems: "baseline" },
  name: { flex: 1, fontSize: 15, fontWeight: "500", color: colors.text },
  time: { fontSize: 11, color: colors.muted, marginLeft: space.sm },
  bottomLine: { flexDirection: "row", alignItems: "center" },
  preview: { flex: 1, fontSize: 13, color: colors.muted },
  previewUnread: { color: colors.text, fontWeight: "500" },
  previewWho: { color: DM_BLUE, fontWeight: "500" },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: DM_BLUE,
    marginLeft: 6,
  },

  empty: { padding: 60, alignItems: "center" },
  emptyTxt: { color: colors.muted, fontSize: 14, textAlign: "center" },

  modalBack: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-start",
    paddingTop: 80,
    paddingHorizontal: 18,
  },
  modalCard: {
    backgroundColor: "white",
    borderRadius: 12,
    maxHeight: "75%",
    overflow: "hidden",
  },
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  modalClose: { fontSize: 22, color: colors.muted, paddingHorizontal: 6 },
  pickerItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pickerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: DM_BLUE,
    alignItems: "center",
    justifyContent: "center",
  },
  pickerAvatarTxt: { color: "white", fontSize: 15, fontWeight: "600" },
  pickerNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pickerName: { fontSize: 14, fontWeight: "500", color: colors.text },
  pickerEmail: { fontSize: 11, color: colors.muted, marginTop: 1 },
  pickerItemInactive: { opacity: 0.55 },
  notSignedInBadge: {
    backgroundColor: "#f3f4f6",
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  notSignedInTxt: {
    fontSize: 8,
    fontWeight: "600",
    color: colors.muted,
    letterSpacing: 0.3,
  },
});
