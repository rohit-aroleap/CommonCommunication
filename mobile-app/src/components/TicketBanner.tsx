// Banner shown at the top of an open thread when there are open tickets on
// the chat. v1.118 compact redesign: single tappable pill row with link-style
// Reassign / Resolve text actions instead of fat outline buttons. Mirrors
// the WhatsApp-style notification-bar density.
//   • Tap Resolve  → opens a note-input modal (and an extra confirmation
//                    when the ticket isn't yours)
//   • Tap Reassign → opens the parent's reassign modal
//
// v1.178: ported the desktop's resolution-note prompt to mobile. Before
// this, tapping Resolve on mobile flipped the ticket to resolved and
// wrote nothing to the chat's notes feed — Bhargav reported "while
// clearing the ticket of Neeti, it directly took as a resolved without
// asking for a note." The note is optional (empty is OK), matching the
// desktop's prompt("(optional)") behavior; when non-empty, the note is
// mirrored into commonComm/chats/{chatKey}/notes/ so anyone reviewing
// the customer later sees the resolution.

import React, { useState } from "react";
import {
  Alert,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { Ticket } from "@/types";
import { push, ref, update } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { encodeKey } from "@/lib/encodeKey";
import { useStyles, useTheme, type Colors } from "@/theme";

interface Props {
  tickets: Ticket[];
  currentUid: string;
  currentName: string;
  onReassign: (ticketId: string) => void;
  // v1.207: tap the banner pill (NOT the inline Reassign/Resolve links)
  // to scroll the thread back to the message this ticket was anchored
  // on. Optional — when absent, the banner text is plain.
  onTap?: (ticket: Ticket) => void;
}

export function TicketBanner({
  tickets,
  currentUid,
  currentName,
  onReassign,
  onTap,
}: Props) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [resolveTarget, setResolveTarget] = useState<Ticket | null>(null);
  const [noteText, setNoteText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // v1.297: long-press the banner → details popup. Tapping the banner only
  // scrolls to the anchor message; it didn't surface the note the assigner
  // wrote (the ticket title) or the message context. This holds the ticket
  // whose details are being shown.
  const [detailsTarget, setDetailsTarget] = useState<Ticket | null>(null);

  // Tap → if it's someone else's ticket, confirm first; then open the
  // note-input modal. Mirrors desktop's confirm() → prompt() chain.
  const onResolvePress = (t: Ticket) => {
    if (t.assignee && t.assignee !== currentUid) {
      Alert.alert(
        "Resolve ticket",
        `This ticket is assigned to ${
          t.assigneeName || "someone else"
        }. Resolve anyway?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Continue", onPress: () => openNoteModal(t) },
        ],
        { cancelable: true },
      );
    } else {
      openNoteModal(t);
    }
  };

  const openNoteModal = (t: Ticket) => {
    setNoteText("");
    setResolveTarget(t);
  };

  const submitResolve = async () => {
    if (!resolveTarget || submitting) return;
    const t = resolveTarget;
    const trimmed = noteText.trim();
    const ts = Date.now();
    const updates: Record<string, unknown> = {
      [`${ROOT}/tickets/${t.id}/status`]: "resolved",
      [`${ROOT}/tickets/${t.id}/resolvedBy`]: currentUid,
      [`${ROOT}/tickets/${t.id}/resolvedByName`]: currentName,
      [`${ROOT}/tickets/${t.id}/resolvedAt`]: ts,
    };
    if (trimmed) {
      updates[`${ROOT}/tickets/${t.id}/resolutionNote`] = trimmed;
      // Mirror into the chat's notes feed so anyone reviewing the
      // customer later sees the resolution. Same shape as the desktop
      // path (index.html resolveTicket) so the renderer doesn't need
      // to branch on which surface created the note.
      if (t.anchorChatId) {
        const chatKey = encodeKey(t.anchorChatId);
        const noteRef = push(ref(db, `${ROOT}/chats/${chatKey}/notes`));
        const titleHint = t.title ? ` "${t.title}"` : "";
        updates[`${ROOT}/chats/${chatKey}/notes/${noteRef.key}`] = {
          text: `🎫 Resolved ticket${titleHint}: ${trimmed}`,
          authorUid: currentUid,
          authorName: currentName,
          createdAt: ts,
          source: "ticket_resolution",
          ticketId: t.id,
        };
      }
    }
    setSubmitting(true);
    try {
      await update(ref(db), updates);
      setResolveTarget(null);
      setNoteText("");
    } catch (e) {
      Alert.alert("Resolve failed", (e as Error)?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelResolve = () => {
    if (submitting) return;
    setResolveTarget(null);
    setNoteText("");
  };

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
            {/* v1.207: the text portion is its own touchable so tapping the
                banner scrolls the thread to the ticket's anchor message.
                Reassign / Resolve are separate touchables to the right so
                they keep their action behavior and don't trigger scroll. */}
            <TouchableOpacity
              style={styles.txtTap}
              onPress={() => onTap?.(t)}
              // v1.297: long-press → ticket details popup (the note the
              // assigner wrote + the message it's about + who/when).
              onLongPress={() => setDetailsTarget(t)}
              delayLongPress={350}
              activeOpacity={onTap ? 0.6 : 1}
              accessibilityLabel="Tap to scroll to the message; long-press for ticket details"
            >
              <Text style={[styles.txt, { color: fg }]} numberOfLines={1}>
                🎫{" "}
                {t.assigneeName ? (
                  <Text style={styles.assignee}>{t.assigneeName}</Text>
                ) : (
                  <Text style={styles.unassigned}>Unassigned</Text>
                )}
                {t.title ? ` · ${t.title}` : ""}
                <Text style={[styles.infoHint, { color: fg }]}> ⓘ</Text>
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onReassign(t.id)}
              hitSlop={8}
              style={styles.linkBtn}
            >
              <Text style={[styles.link, { color: fg }]}>Reassign</Text>
            </TouchableOpacity>
            <Text style={[styles.sep, { color: fg }]}>·</Text>
            <TouchableOpacity
              onPress={() => onResolvePress(t)}
              hitSlop={8}
              style={styles.linkBtn}
            >
              <Text style={[styles.link, { color: fg }]}>Resolve</Text>
            </TouchableOpacity>
          </View>
        );
      })}

      {/* v1.297: ticket details popup — opened by long-pressing the
          banner. Shows the full note the assigner wrote (the ticket
          title), the message it's about, who's on it, when it was
          created, and any reassignment trail. Read-only. */}
      <Modal
        visible={!!detailsTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setDetailsTarget(null)}
      >
        <TouchableOpacity
          style={styles.modalScrim}
          activeOpacity={1}
          onPress={() => setDetailsTarget(null)}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>🎫 Ticket details</Text>
            {detailsTarget?.title ? (
              <>
                <Text style={styles.detailLabel}>
                  Note from {detailsTarget.createdByName || "teammate"}
                </Text>
                <Text style={styles.detailNote}>{detailsTarget.title}</Text>
              </>
            ) : null}
            {detailsTarget?.anchorText ? (
              <>
                <Text style={styles.detailLabel}>About this message</Text>
                <Text style={styles.detailQuote}>
                  “{detailsTarget.anchorText}”
                </Text>
              </>
            ) : null}
            <Text style={styles.detailLabel}>Assigned to</Text>
            <Text style={styles.detailValue}>
              {detailsTarget?.assigneeName || "Unassigned"}
            </Text>
            {detailsTarget?.createdAt ? (
              <>
                <Text style={styles.detailLabel}>Created</Text>
                <Text style={styles.detailValue}>
                  {new Date(detailsTarget.createdAt).toLocaleString()}
                  {detailsTarget.createdByName
                    ? ` · by ${detailsTarget.createdByName}`
                    : ""}
                </Text>
              </>
            ) : null}
            {detailsTarget?.reassignments &&
            detailsTarget.reassignments.length ? (
              <>
                <Text style={styles.detailLabel}>Reassignment history</Text>
                {detailsTarget.reassignments.map((r, i) => (
                  <Text key={i} style={styles.detailReassign}>
                    {r.byName || "Someone"}: {r.fromName || "Unassigned"} →{" "}
                    {r.toName}
                  </Text>
                ))}
              </>
            ) : null}
            <View style={styles.modalActions}>
              <TouchableOpacity
                onPress={() => setDetailsTarget(null)}
                style={[styles.modalBtn, styles.modalBtnPrimary]}
              >
                <Text style={styles.modalBtnPrimaryTxt}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={!!resolveTarget}
        transparent
        animationType="fade"
        onRequestClose={cancelResolve}
      >
        <View style={styles.modalScrim}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Resolve ticket</Text>
            {resolveTarget?.title ? (
              <Text style={styles.modalSubtitle} numberOfLines={2}>
                {resolveTarget.title}
              </Text>
            ) : null}
            <Text style={styles.modalLabel}>Resolution note (optional)</Text>
            <TextInput
              value={noteText}
              onChangeText={setNoteText}
              placeholder="What was the resolution?"
              placeholderTextColor={colors.muted}
              style={styles.modalInput}
              multiline
              autoFocus
              editable={!submitting}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                onPress={cancelResolve}
                disabled={submitting}
                style={[styles.modalBtn, styles.modalBtnSecondary]}
              >
                <Text style={styles.modalBtnSecondaryTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitResolve}
                disabled={submitting}
                style={[styles.modalBtn, styles.modalBtnPrimary]}
              >
                <Text style={styles.modalBtnPrimaryTxt}>
                  {submitting ? "Resolving…" : "Resolve"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderBottomWidth: StyleSheet.hairlineWidth,
      gap: 6,
    },
    // v1.207: the tappable wrapper for the banner text. flex:1 so the
    // text fills the available space pushing Reassign/Resolve to the
    // right edge — same layout the plain Text used to have.
    txtTap: { flex: 1 },
    txt: { fontSize: 12 },
    assignee: { fontWeight: "600" },
    unassigned: { fontStyle: "italic", opacity: 0.85 },
    linkBtn: { paddingHorizontal: 2 },
    link: { fontSize: 12, fontWeight: "600", textDecorationLine: "underline" },
    sep: { fontSize: 12, opacity: 0.5, paddingHorizontal: 1 },
    // v1.297: subtle ⓘ hint that the banner is long-pressable for details.
    infoHint: { fontSize: 11, opacity: 0.7 },
    // Details popup rows.
    detailLabel: {
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.3,
      color: colors.muted,
      marginTop: 10,
      textTransform: "uppercase",
    },
    detailNote: {
      fontSize: 15,
      color: colors.text,
      lineHeight: 21,
      marginTop: 2,
    },
    detailQuote: {
      fontSize: 13,
      color: colors.text,
      fontStyle: "italic",
      lineHeight: 19,
      marginTop: 2,
    },
    detailValue: { fontSize: 14, color: colors.text, marginTop: 2 },
    detailReassign: { fontSize: 12, color: colors.muted, marginTop: 2 },

    // Modal styles. The scrim is intentionally darker than typical RN
    // modals so it works visibly in both light and dark themes.
    modalScrim: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "center",
      alignItems: "center",
      padding: 20,
    },
    modalCard: {
      width: "100%",
      maxWidth: 380,
      backgroundColor: colors.panel,
      borderRadius: 14,
      padding: 18,
      gap: 8,
    },
    modalTitle: {
      fontSize: 16,
      fontWeight: "600",
      color: colors.text,
    },
    modalSubtitle: {
      fontSize: 12,
      color: colors.muted,
      marginBottom: 4,
    },
    modalLabel: {
      fontSize: 12,
      color: colors.muted,
      marginTop: 6,
    },
    modalInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 14,
      color: colors.text,
      minHeight: 70,
      maxHeight: 140,
      textAlignVertical: "top",
      backgroundColor: colors.bg,
    },
    modalActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 6,
    },
    modalBtn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      minWidth: 80,
      alignItems: "center",
    },
    modalBtnSecondary: {
      backgroundColor: "transparent",
    },
    modalBtnSecondaryTxt: {
      color: colors.muted,
      fontSize: 14,
      fontWeight: "500",
    },
    modalBtnPrimary: {
      backgroundColor: colors.green,
    },
    modalBtnPrimaryTxt: {
      color: "white",
      fontSize: 14,
      fontWeight: "600",
    },
  });
}
