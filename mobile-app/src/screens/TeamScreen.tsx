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
import { space, useStyles, useTheme, type Colors } from "@/theme";
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

// Unified row shape used by the list — existing DMs and "not yet started"
// teammates both render through the same code path.
interface UnifiedRow {
  kind: "existing" | "new-active" | "new-inactive";
  otherUid: string | null;
  chatKey: string | null;
  name: string;
  email: string;
  lastMsgAt: number;
  preview: string;
  lastMsgFromUid: string | null;
  lastMsgFromName: string | null;
  unread: boolean;
}

export function TeamScreen() {
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const { dmRows, teamUsers, teamMembers } = useAppData();
  const [search, setSearch] = useState("");
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);

  // Three-source merge — every teammate gets a row, whether or not we have
  // an existing DM thread for them. Same pattern as the desktop v1.110
  // Team-tab simplification: no "pick a teammate" step, tap any row to
  // open/create the DM.
  const rows = useMemo<UnifiedRow[]>(() => {
    const me = user?.uid;
    const myEmail = (user?.email || "").toLowerCase();
    const seenUids = new Set<string>();
    const seenEmails = new Set<string>();
    const out: UnifiedRow[] = [];

    // A: existing DM threads
    for (const r of dmRows) {
      seenUids.add(r.otherUid);
      const u = teamUsers[r.otherUid];
      if (u?.email) seenEmails.add(u.email.toLowerCase());
      out.push({
        kind: "existing",
        otherUid: r.otherUid,
        chatKey: r.chatKey,
        name: r.name,
        email: r.email,
        lastMsgAt: r.lastMsgAt,
        preview: r.preview,
        lastMsgFromUid: r.lastMsgFromUid,
        lastMsgFromName: r.lastMsgFromName,
        unread: r.unread,
      });
    }

    // B: signed-in teammates without a DM thread yet
    for (const [uid, u] of Object.entries(teamUsers)) {
      if (uid === me || seenUids.has(uid)) continue;
      const emailLower = String(u?.email || "").toLowerCase();
      if (emailLower) seenEmails.add(emailLower);
      out.push({
        kind: "new-active",
        otherUid: uid,
        chatKey: null,
        name: u?.name || u?.email || "(unknown)",
        email: u?.email || "",
        lastMsgAt: 0,
        preview: "",
        lastMsgFromUid: null,
        lastMsgFromName: null,
        unread: false,
      });
    }

    // C: configured-but-not-signed-in teammates
    for (const m of Object.values(teamMembers || {})) {
      if (!m?.email) continue;
      const emailLower = m.email.toLowerCase();
      if (emailLower === myEmail) continue;
      if (seenEmails.has(emailLower)) continue;
      out.push({
        kind: "new-inactive",
        otherUid: null,
        chatKey: null,
        name: m.name || m.email,
        email: m.email,
        lastMsgAt: 0,
        preview: "",
        lastMsgFromUid: null,
        lastMsgFromName: null,
        unread: false,
      });
      seenEmails.add(emailLower);
    }

    out.sort((a, b) => {
      const w = (k: UnifiedRow["kind"]) =>
        k === "existing" ? 0 : k === "new-active" ? 1 : 2;
      if (w(a.kind) !== w(b.kind)) return w(a.kind) - w(b.kind);
      if (a.kind === "existing") return (b.lastMsgAt || 0) - (a.lastMsgAt || 0);
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [dmRows, teamUsers, teamMembers, user]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.email || "").toLowerCase().includes(q),
    );
  }, [rows, search]);

  const openDm = async (row: UnifiedRow) => {
    if (!user) return;
    if (row.kind === "new-inactive") {
      Alert.alert(
        `${row.name} hasn't signed in yet`,
        "Ask them to sign in to the dashboard or mobile app once with their email, and they'll be DM-able.",
      );
      return;
    }
    if (row.kind === "existing" && row.chatKey) {
      navigation.navigate("Thread", {
        chatKey: row.chatKey,
        initialTitle: row.name,
      });
      return;
    }
    // new-active: create the DM idempotently then navigate
    const otherUid = row.otherUid!;
    const pairKey = getPairKey(user.uid, otherUid);
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
    navigation.navigate("Thread", {
      chatKey: chatKeyFromPairKey(pairKey),
      initialTitle: row.name,
    });
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <Text style={styles.searchIcn}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search teammates"
            placeholderTextColor={colors.muted}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {search.length > 0 && (
            <Text
              style={styles.searchClear}
              onPress={() => setSearch("")}
              accessibilityLabel="Clear search"
            >
              ×
            </Text>
          )}
        </View>
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(r) => r.chatKey || `uid:${r.otherUid}` || `email:${r.email}`}
        renderItem={({ item }) => (
          <UnifiedRowItem
            row={item}
            isMe={item.lastMsgFromUid === user?.uid}
            onPress={() => openDm(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTxt}>
              {search
                ? "No teammates match."
                : "No teammates configured yet. Ask an admin to add them on the desktop dashboard."}
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

function UnifiedRowItem({
  row,
  isMe,
  onPress,
}: {
  row: UnifiedRow;
  isMe: boolean;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const initial = (row.name?.[0] || "?").toUpperCase();
  const isInactive = row.kind === "new-inactive";
  const placeholder =
    row.kind === "new-active"
      ? "No messages yet — tap to start"
      : row.kind === "new-inactive"
        ? "Not signed in yet"
        : "";
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.row, isInactive && styles.rowInactive]}
      activeOpacity={0.6}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarTxt}>{initial}</Text>
      </View>
      <View style={styles.col}>
        <View style={styles.topLine}>
          <View style={styles.nameWrap}>
            <Text style={styles.name} numberOfLines={1}>
              {row.name}
            </Text>
            {isInactive && (
              <View style={styles.notSignedInBadge}>
                <Text style={styles.notSignedInTxt}>NOT SIGNED IN</Text>
              </View>
            )}
          </View>
          {row.lastMsgAt > 0 && (
            <Text style={styles.time}>{formatTime(row.lastMsgAt)}</Text>
          )}
        </View>
        <View style={styles.bottomLine}>
          <Text
            style={[
              styles.preview,
              row.unread && styles.previewUnread,
              !row.preview && styles.previewEmpty,
            ]}
            numberOfLines={1}
          >
            {isMe && row.lastMsgFromName ? (
              <Text style={styles.previewWho}>{row.lastMsgFromName}: </Text>
            ) : null}
            {row.preview || placeholder}
          </Text>
          {row.unread && <View style={styles.unreadDot} />}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// NOTE: Kept the PickerModal definition (and its styles) in this file but
// it's no longer used by TeamScreen — v1.111 listed every teammate as a
// direct row instead of behind a "pick a teammate" modal step. Leaving the
// dead code in place so we can resurrect it if we ever need an explicit
// "Invite teammate" flow for admins.

interface PickerCandidate {
  uid: string | null;
  name: string;
  email: string;
  active: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  const styles = useStyles(makeStyles);
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

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    searchRow: {
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      backgroundColor: colors.panel,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.bg,
      borderRadius: 22,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    searchIcn: { color: colors.muted, fontSize: 13, marginRight: 8 },
    searchInput: { flex: 1, paddingVertical: 10, fontSize: 15, color: colors.text },
    searchClear: { fontSize: 22, color: colors.muted, paddingHorizontal: 6, paddingVertical: 2 },
    newRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: space.md + 2,
      paddingVertical: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.rowHover,
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
    newTitle: { fontSize: 15, fontWeight: "500", color: DM_BLUE },
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
    previewEmpty: { fontStyle: "italic", opacity: 0.85 },
    rowInactive: { opacity: 0.55 },
    nameWrap: { flexDirection: "row", alignItems: "center", flex: 1, gap: 6 },
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
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "flex-start",
      paddingTop: 80,
      paddingHorizontal: 18,
    },
    modalCard: {
      backgroundColor: colors.panel,
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
      backgroundColor: colors.rowHover,
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
}
