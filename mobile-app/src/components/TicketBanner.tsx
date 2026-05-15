// Banner shown at the top of an open thread when there are open tickets on
// the chat. Tap Resolve to close (confirms when the ticket isn't yours,
// matching desktop behaviour); tap Reassign to open the reassign modal.

import React from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors, space } from "@/theme";
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
        return (
          <View
            key={t.id}
            style={[styles.banner, mine ? styles.bannerMine : styles.banner]}
          >
            <Text style={mine ? styles.txtMine : styles.txt} numberOfLines={1}>
              🎫 {t.title || "Ticket"}
              {t.assigneeName ? ` · ${t.assigneeName}` : ""}
            </Text>
            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[styles.btn, mine ? styles.btnMine : styles.btn]}
                onPress={() => onReassign(t.id)}
              >
                <Text style={mine ? styles.btnTxtMine : styles.btnTxt}>
                  Reassign
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, mine ? styles.btnMine : styles.btn]}
                onPress={() => confirmResolve(t, currentUid, currentName)}
              >
                <Text style={mine ? styles.btnTxtMine : styles.btnTxt}>
                  Resolve
                </Text>
              </TouchableOpacity>
            </View>
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
    paddingVertical: 8,
    backgroundColor: "#fee2e2",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#fecaca",
    gap: 8,
  },
  bannerMine: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#fef3c7",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#fde68a",
    gap: 8,
  },
  txt: { color: "#991b1b", fontSize: 12, flex: 1 },
  txtMine: { color: "#92400e", fontSize: 12, flex: 1 },
  btnRow: { flexDirection: "row", gap: 4 },
  btn: {
    backgroundColor: "white",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#991b1b",
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  btnMine: {
    backgroundColor: "white",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#92400e",
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  btnTxt: { color: "#991b1b", fontSize: 12, fontWeight: "500" },
  btnTxtMine: { color: "#92400e", fontSize: 12, fontWeight: "500" },
});
