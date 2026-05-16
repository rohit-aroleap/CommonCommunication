// Create-ticket modal. Same write shape as desktop's createTicket() — both
// the top-level commonComm/tickets/{id} record and the per-chat
// commonComm/chats/{chatKey}/tickets/{id}=true index, in a single
// multi-path update.

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { push, ref, update } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { encodeKey } from "@/lib/encodeKey";
import { space, useStyles, type Colors } from "@/theme";
import type { Message, TeamUser } from "@/types";

interface Props {
  visible: boolean;
  message: Message | null;
  chatId: string;
  currentUid: string;
  currentName: string;
  teamUsers: Record<string, TeamUser>;
  onClose: () => void;
}

export function CreateTicketModal({
  visible,
  message,
  chatId,
  currentUid,
  currentName,
  teamUsers,
  onClose,
}: Props) {
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState(currentUid);
  const [busy, setBusy] = useState(false);
  const styles = useStyles(makeStyles);

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
    if (!visible || !message) return;
    const src = msgQuoteText(message);
    setTitle(src.slice(0, 80));
    setAssignee(currentUid);
  }, [visible, message, currentUid]);

  if (!message) return null;
  const quote = msgQuoteText(message);

  const submit = async () => {
    if (!title.trim()) return;
    const selected = assignees.find((a) => a.uid === assignee);
    if (!selected) return;
    setBusy(true);
    try {
      const titleSrc = quote.trim();
      const ticketRef = push(ref(db, `${ROOT}/tickets`));
      const id = ticketRef.key as string;
      const ticket = {
        title: title.slice(0, 80) || titleSrc.slice(0, 80) || "[empty message]",
        anchorChatId: chatId,
        anchorMsgKey: message.id,
        anchorText: titleSrc.slice(0, 240),
        assignee: selected.uid,
        assigneeName: selected.name,
        status: "open",
        createdBy: currentUid,
        createdByName: currentName,
        createdAt: Date.now(),
      };
      const updates: Record<string, unknown> = {};
      updates[`${ROOT}/tickets/${id}`] = ticket;
      updates[`${ROOT}/chats/${encodeKey(chatId)}/tickets/${id}`] = true;
      await update(ref(db), updates);
      onClose();
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
          <Text style={styles.title}>Create ticket</Text>
          <Text style={styles.sub}>Anchored to the selected message</Text>
          <View style={styles.quote}>
            <Text style={styles.quoteTxt} numberOfLines={3}>
              {quote}
            </Text>
          </View>
          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            maxLength={80}
            placeholder="Short summary"
            placeholderTextColor={(styles.label as { color: string }).color}
          />
          <Text style={styles.label}>Assign to</Text>
          <ScrollView style={styles.assigneeList} keyboardShouldPersistTaps="handled">
            {assignees.map((a) => {
              const sel = a.uid === assignee;
              return (
                <TouchableOpacity
                  key={a.uid}
                  style={[styles.assignee, sel && styles.assigneeSel]}
                  onPress={() => setAssignee(a.uid)}
                >
                  <Text style={[styles.assigneeTxt, sel && styles.assigneeTxtSel]}>
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
                <Text style={[styles.btnTxt, styles.btnTxtPrimary]}>Create</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function msgQuoteText(m: Message): string {
  return m.text || m.media?.caption || m.media?.fileName || "[media]";
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
    quote: {
      backgroundColor: colors.rowHover,
      borderLeftWidth: 3,
      borderLeftColor: colors.green,
      borderRadius: 4,
      padding: 8,
      marginBottom: 14,
    },
    quoteTxt: { fontSize: 13, color: colors.muted },
    label: {
      fontSize: 11,
      color: colors.muted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 4,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: colors.text,
      backgroundColor: colors.bg,
      marginBottom: 14,
    },
    assigneeList: { maxHeight: 200, marginBottom: 12 },
    assignee: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 6,
    },
    assigneeSel: { backgroundColor: colors.rowHover },
    assigneeTxt: { fontSize: 14, color: colors.text, flex: 1 },
    assigneeTxtSel: { fontWeight: "500", color: colors.green },
    check: { color: colors.green, fontSize: 16 },
    btnRow: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
    btn: {
      paddingVertical: 9,
      paddingHorizontal: 16,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      minWidth: 80,
      alignItems: "center",
    },
    btnPrimary: { backgroundColor: colors.green, borderColor: colors.green },
    btnDisabled: { opacity: 0.6 },
    btnTxt: { fontSize: 14, color: colors.text },
    btnTxtPrimary: { color: "white", fontWeight: "500" },
  });
}
