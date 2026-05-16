// Banner shown at the top of an open thread when there are open tickets on
// the chat. v1.118 compact redesign: single tappable pill row with link-style
// Reassign / Resolve text actions instead of fat outline buttons. Mirrors
// the WhatsApp-style notification-bar density.
//   • Tap Resolve  → confirms (extra prompt when ticket isn't yours)
//   • Tap Reassign → opens the parent's reassign modal

import React from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { Ticket } from "@/types";
import { ref, update } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";

interface Props {
  tickets: Ticket[];
  currentUid: string;
  currentName: string;
  onReassign: (ticketId: string) => void;
}

export function TicketBanner({
  tickets,
  currentUid,
  currentName,
  onReassign,
}: Props) {
  if (!tickets.length) return null;
  return (
    <View>
      {tickets.map((t) => {
        const mine = t.assignee === currentUid;
        const bg = mine ? "#fef3c7" : "#fee2e2";
        const border = mine ? "#fde68a" : "#fecaca";
        const fg = mine ? "#92400e" : "#991b1b";
        return (
          <View
            key={t.id}
            style={[
              styles.banner,
              { backgroundColor: bg, borderBottomColor: border },
            ]}
          >
            <Text style={[styles.txt, { color: fg }]} numberOfLines={1}>
              🎫{" "}
              {t.assigneeName ? (
                <Text style={styles.assignee}>{t.assigneeName}</Text>
              ) : (
                <Text style={styles.unassigned}>Unassigned</Text>
              )}
              {t.title ? ` · ${t.title}` : ""}
            </Text>
            <TouchableOpacity
              onPress={() => onReassign(t.id)}
              hitSlop={8}
              style={styles.linkBtn}
            >
              <Text style={[styles.link, { color: fg }]}>Reassign</Text>
            </TouchableOpacity>
            <Text style={[styles.sep, { color: fg }]}>·</Text>
            <TouchableOpacity
              onPress={() => confirmResolve(t, currentUid, currentName)}
              hitSlop={8}
              style={styles.linkBtn}
            >
              <Text style={[styles.link, { color: fg }]}>Resolve</Text>
            </TouchableOpacity>
          </View>
        );
      })}
    </View>
  );
}

function confirmResolve(t: Ticket, uid: string, displayName: string) {
  const isMine = t.assignee === uid;
  const message = isMine
    ? `Resolve "${t.title || "this ticket"}"?`
    : `This ticket is assigned to ${
        t.assigneeName || "someone else"
      }. Resolve anyway?`;
  Alert.alert(
    "Resolve ticket",
    message,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Resolve",
        style: "destructive",
        onPress: async () => {
          const updates: Record<string, unknown> = {};
          updates[`${ROOT}/tickets/${t.id}/status`] = "resolved";
          updates[`${ROOT}/tickets/${t.id}/resolvedBy`] = uid;
          updates[`${ROOT}/tickets/${t.id}/resolvedByName`] = displayName;
          updates[`${ROOT}/tickets/${t.id}/resolvedAt`] = Date.now();
          try {
            await update(ref(db), updates);
          } catch (e: any) {
            Alert.alert("Resolve failed", e?.message ?? String(e));
          }
        },
      },
    ],
    { cancelable: true },
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  txt: { fontSize: 12, flex: 1 },
  assignee: { fontWeight: "600" },
  unassigned: { fontStyle: "italic", opacity: 0.85 },
  linkBtn: { paddingHorizontal: 2 },
  link: { fontSize: 12, fontWeight: "600", textDecorationLine: "underline" },
  sep: { fontSize: 12, opacity: 0.5, paddingHorizontal: 1 },
});
