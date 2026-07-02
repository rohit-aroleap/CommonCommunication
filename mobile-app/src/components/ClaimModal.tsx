// v1.355: Claim picker — mirror of the web claim popover. Tap yourself to
// claim the chat, a teammate to assign the claim to them, or Unclaim to
// release it. Writes commonComm/claims/{chatKey} = {uid, name, at} (shared
// with the web app); tap acts immediately (no confirm step), like web.

import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ref, remove, set } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { resolveTeammateName } from "@/lib/teamFilter";
import { useStyles, type Colors } from "@/theme";
import type { ChatClaim, TeamMember, TeamUser } from "@/types";

interface Props {
  visible: boolean;
  chatKey: string;
  claim: ChatClaim | null;
  currentUid: string;
  currentName: string;
  teamUsers: Record<string, TeamUser>;
  teamMembers: Record<string, TeamMember>;
  onClose: () => void;
}

export function ClaimModal({
  visible,
  chatKey,
  claim,
  currentUid,
  currentName,
  teamUsers,
  teamMembers,
  onClose,
}: Props) {
  const [busy, setBusy] = useState(false);
  const styles = useStyles(makeStyles);

  // Me first (one-tap self-claim), then teammates alphabetically — same list
  // the ReassignModal builds.
  const people = useMemo(() => {
    const out: Array<{ uid: string; name: string }> = [];
    const seen = new Set<string>();
    if (currentUid) {
      out.push({ uid: currentUid, name: currentName });
      seen.add(currentUid);
    }
    const rest: Array<{ uid: string; name: string }> = [];
    for (const [uid, u] of Object.entries(teamUsers || {})) {
      if (seen.has(uid) || !u) continue;
      seen.add(uid);
      rest.push({
        uid,
        name: resolveTeammateName(uid, u.email, teamUsers, teamMembers),
      });
    }
    rest.sort((a, b) => a.name.localeCompare(b.name));
    return out.concat(rest);
  }, [teamUsers, teamMembers, currentUid, currentName]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onClose();
    } catch (e: any) {
      Alert.alert("Claim failed", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = (uid: string, name: string) =>
    act(() => set(ref(db, `${ROOT}/claims/${chatKey}`), { uid, name, at: Date.now() }));
  const unclaim = () => act(() => remove(ref(db, `${ROOT}/claims/${chatKey}`)));

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.back} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>Claim chat</Text>
          <Text style={styles.sub}>
            {claim?.uid
              ? `Currently claimed by ${claim.name || "someone"} — tap to reassign`
              : "Tap yourself to claim, or a teammate to assign it to them"}
          </Text>
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {people.map((p) => {
              const isClaimer = claim?.uid === p.uid;
              return (
                <TouchableOpacity
                  key={p.uid}
                  style={[styles.item, isClaimer && styles.itemSel]}
                  onPress={() => pick(p.uid, p.name)}
                  disabled={busy}
                >
                  <Text style={[styles.itemTxt, isClaimer && styles.itemTxtSel]}>
                    {p.name}
                    {p.uid === currentUid ? " (me)" : ""}
                  </Text>
                  {isClaimer && <Text style={styles.check}>✓</Text>}
                </TouchableOpacity>
              );
            })}
            {claim?.uid ? (
              <TouchableOpacity
                style={styles.item}
                onPress={unclaim}
                disabled={busy}
              >
                <Text style={styles.unclaimTxt}>✖ Unclaim — release this chat</Text>
              </TouchableOpacity>
            ) : null}
          </ScrollView>
          <View style={styles.btnRow}>
            {busy ? <ActivityIndicator /> : null}
            <TouchableOpacity style={styles.btn} onPress={onClose} disabled={busy}>
              <Text style={styles.btnTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    back: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "center",
      alignItems: "center",
      padding: 16,
    },
    card: {
      width: "100%",
      maxWidth: 380,
      backgroundColor: colors.panel,
      borderRadius: 12,
      padding: 20,
      maxHeight: "85%",
    },
    title: { fontSize: 17, fontWeight: "600", color: colors.text },
    sub: { fontSize: 12, color: colors.muted, marginBottom: 12, marginTop: 2 },
    list: { maxHeight: 300, marginBottom: 12 },
    item: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderRadius: 6,
    },
    itemSel: { backgroundColor: colors.rowHover },
    itemTxt: { fontSize: 14, color: colors.text, flex: 1 },
    itemTxtSel: { fontWeight: "500", color: colors.green },
    check: { color: colors.green, fontSize: 16 },
    unclaimTxt: { fontSize: 14, color: colors.red, flex: 1 },
    btnRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      alignItems: "center",
      gap: 10,
    },
    btn: {
      paddingVertical: 9,
      paddingHorizontal: 16,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      minWidth: 100,
      alignItems: "center",
    },
    btnTxt: { fontSize: 14, color: colors.text },
  });
}
