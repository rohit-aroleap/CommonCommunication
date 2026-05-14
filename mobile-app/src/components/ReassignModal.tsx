// Reassign-ticket modal. Writes assignee + assigneeName + appends to the
// reassignments[] audit array exactly like desktop's reassignTicket().

import React, { useEffect, useMemo, useState } from "react";
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
import { ref, update } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { colors } from "@/theme";
import type { TeamUser, Ticket } from "@/types";

interface Props {
  visible: boolean;
  ticket: Ticket | null;
  currentUid: string;
  currentName: string;
  teamUsers: Record<string, TeamUser>;
  onClose: () => void;
}

export function ReassignModal({
  visible,
  ticket,
  currentUid,
  currentName,
  teamUsers,
  onClose,
}: Props) {
  const [assignee, setAssignee] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const assignees = useMemo(() => {
    const out: Array<{ uid: string; name: string }> = [];
    const seen = new Set<string>();
    if (currentUid) {
      out.push({ uid: currentUid, name: currentName });
      seen.add(currentUid);
    }
    for (const [uid, u] of Object.entries(teamUsers || {})) {
      if (seen.has(uid) || !u) continue;
      seen.add(uid);
      out.push({ uid, name: u.name || u.email || uid });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [teamUsers, currentUid, currentName]);

  useEffect(() => {
    if (!visible || !ticket) return;
    setAssignee(ticket.assignee);
  }, [visible, ticket]);

  if (!ticket) return null;

  const submit = async () => {
    if (!assignee || assignee === ticket.assignee) {
      onClose();
      return;
    }
    const target = assignees.find((a) => a.uid === assignee);
    if (!target) return;
    setBusy(true);
    try {
      const reassignEntry = {
        from: ticket.assignee || null,
        fromName: ticket.assigneeName || null,
        to: target.uid,
        toName: target.name,
        at: Date.now(),
        byUid: currentUid,
        byName: currentName,
      };
      const existing = ticket.reassignments || [];
      const updates: Record<string, unknown> = {};
      updates[`${ROOT}/tickets/${ticket.id}/assignee`] = target.uid;
      updates[`${ROOT}/tickets/${ticket.id}/assigneeName`] = target.name;
      updates[`${ROOT}/tickets/${ticket.id}/reassignments`] = [
        ...existing,
        reassignEntry,
      ];
      await update(ref(db), updates);
      onClose();
    } catch (e: any) {
      Alert.alert("Reassign failed", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.back} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>Reassign ticket</Text>
          <Text style={styles.sub}>Pick a new owner</Text>
          <View style={styles.quote}>
            <Text style={styles.quoteTxt} numberOfLines={2}>
              {ticket.title || "(no title)"}
              {ticket.assigneeName ? ` · currently ${ticket.assigneeName}` : ""}
            </Text>
          </View>
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {assignees.map((a) => {
              const sel = a.uid === assignee;
              return (
                <TouchableOpacity
                  key={a.uid}
                  style={[styles.item, sel && styles.itemSel]}
                  onPress={() => setAssignee(a.uid)}
                >
                  <Text style={[styles.itemTxt, sel && styles.itemTxtSel]}>
                    {a.name}
                    {a.uid === currentUid ? " (me)" : ""}
                  </Text>
                  {sel && <Text style={styles.check}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.btn} onPress={onClose}>
              <Text style={styles.btnTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
              onPress={submit}
              disabled={busy}
            >
              {busy ? <ActivityIndicator color="white" /> : (
                <Text style={[styles.btnTxt, styles.btnTxtPrimary]}>Reassign</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  back: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "white",
    borderRadius: 12,
    padding: 20,
    maxHeight: "85%",
  },
  title: { fontSize: 17, fontWeight: "600", color: colors.text },
  sub: { fontSize: 12, color: colors.muted, marginBottom: 12, marginTop: 2 },
  quote: {
    backgroundColor: "#f0f2f5",
    borderLeftWidth: 3,
    borderLeftColor: colors.green,
    borderRadius: 4,
    padding: 8,
    marginBottom: 14,
  },
  quoteTxt: { fontSize: 13, color: colors.muted },
  list: { maxHeight: 280, marginBottom: 12 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 6,
  },
  itemSel: { backgroundColor: "#f0f2f5" },
  itemTxt: { fontSize: 14, color: colors.text, flex: 1 },
  itemTxtSel: { fontWeight: "500", color: colors.greenDark },
  check: { color: colors.greenDark, fontSize: 16 },
  btnRow: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  btn: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 100,
    alignItems: "center",
  },
  btnPrimary: { backgroundColor: colors.green, borderColor: colors.green },
  btnDisabled: { opacity: 0.6 },
  btnTxt: { fontSize: 14, color: colors.text },
  btnTxtPrimary: { color: "white", fontWeight: "500" },
});
