// Single message bubble.
//   • Single tap     → onPress (parent opens "Create ticket" flow)
//   • Long-press     → onLongPress (parent shows action menu / copies)
// Mirrors the webapp's click-to-ticket / long-press-to-copy split.
// v1.152: reactions render as a pill below the bubble; aggregated by
// emoji (👍 ×2, ❤️ ×1, etc.) with WhatsApp-style placement.
// Media is rendered through the Worker's /media proxy because Periskope-
// hosted URLs require auth headers we can't attach to a plain <Image>.

import React from "react";
import {
  Image,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { space, useStyles, useTheme, type Colors } from "@/theme";
import { mediaProxyUrl } from "@/lib/worker";
import { FormattedText } from "@/lib/whatsappFormat";
import type { Message } from "@/types";

interface Props {
  message: Message;
  isGroup: boolean;
  resolveSenderName: (phone: string) => string;
  onPress: (m: Message) => void;
  onLongPress: (m: Message) => void;
  // v1.194: image taps open the in-app MediaViewerModal (parent-managed)
  // instead of Linking.openURL'ing out to Safari/Chrome. Non-image media
  // still uses Linking via the default path inside MediaBlock.
  onImagePress?: (url: string) => void;
}

export function MessageBubble({
  message: m,
  isGroup,
  resolveSenderName,
  onPress,
  onLongPress,
  onImagePress,
}: Props) {
  const styles = useStyles(makeStyles);
  const out = m.direction === "out";
  const senderTag = out
    ? m.sentByName
      ? `— ${m.sentByName}`
      : null
    : isGroup && m.senderPhone
    ? `~ ${resolveSenderName(m.senderPhone)}`
    : null;

  // v1.151: deleted messages render a "Message deleted" placeholder in
  // place of their original content (WhatsApp pattern). We still keep
  // the bubble visible so ticket-anchor records have somewhere to point.
  const isDeleted = m.deleted === true;
  const isEdited = !isDeleted && !!m.editedAt;

  // Detect "empty" messages: no text, no usable media. Periskope occasionally
  // sends these (reaction-only, deleted-for-me, system events). Without this
  // guard they render as ghost bubbles with just a timestamp — looks broken.
  // Deleted messages get their own bubble, so skip the empty-bubble cull.
  const hasText = !!(m.text && m.text.trim());
  const hasMedia = !!(m.media && (m.media.url || m.media.fileName));
  if (!isDeleted && !hasText && !hasMedia) {
    return null;
  }

  return (
    <View style={[styles.row, out ? styles.rowOut : styles.rowIn]}>
      <TouchableOpacity
        delayLongPress={420}
        onPress={() => onPress(m)}
        onLongPress={() => onLongPress(m)}
        activeOpacity={0.85}
        style={[
          styles.bubble,
          out ? styles.bubbleOut : styles.bubbleIn,
          isDeleted && styles.bubbleDeleted,
        ]}
      >
        {senderTag && <Text style={styles.senderTag}>{senderTag}</Text>}
        {/* v1.154 forwarded-from header. Renders above the body when a
            DM message was forwarded from a customer thread. Shows ↪️
            with the source customer's name so the recipient sees the
            context at a glance. */}
        {!isDeleted && m.forwardedFrom && (
          <View style={styles.forwardedHeader}>
            <Text style={styles.forwardedTxt} numberOfLines={1}>
              ↪️ Forwarded from {m.forwardedFrom.customerName || "customer"}
            </Text>
          </View>
        )}
        {/* v1.153 quoted card. If this message was sent as a reply,
            render a snippet of the parent above the body so the trainer
            (and the customer, mirroring WhatsApp) can see what's being
            answered without scrolling. */}
        {!isDeleted && m.replyTo && (
          <View style={styles.replyQuote}>
            <Text style={styles.replyQuoteLabel} numberOfLines={1}>
              {m.replyTo.isFromMe
                ? "You"
                : m.replyTo.senderName || "Customer"}
            </Text>
            <Text style={styles.replyQuoteTxt} numberOfLines={2}>
              {m.replyTo.text || "(media)"}
            </Text>
          </View>
        )}
        {isDeleted ? (
          <Text style={styles.deletedTxt}>🚫 This message was deleted</Text>
        ) : (
          <>
            <MediaBlock
              media={m.media}
              onLongPress={() => onLongPress(m)}
              onImagePress={onImagePress}
            />
            {hasText ? (
              <FormattedText text={m.text!} baseStyle={styles.text} />
            ) : null}
          </>
        )}
        <View style={styles.footer}>
          {isEdited && <Text style={styles.editedTag}>edited</Text>}
          <Text style={styles.clock}>{formatClock(m.ts)}</Text>
          {out && !isDeleted && <Status status={m.status} />}
        </View>
      </TouchableOpacity>
      {/* v1.152 reactions pill — rendered OUTSIDE the bubble's
          TouchableOpacity so tapping a reaction doesn't fire the
          create-ticket flow. Aligned to the same side as the bubble
          (right for outbound, left for inbound). */}
      <ReactionsPill reactions={m.reactions} out={out} />
    </View>
  );
}

// Group reactions by emoji and render a compact pill. Shows up to 4
// distinct emojis with their counts; if the customer was one of the
// reactors, their emoji shows first (matches WhatsApp's "most recent"
// emphasis). Returns null if no reactions — keeps the bubble tight.
function ReactionsPill({
  reactions,
  out,
}: {
  reactions: Message["reactions"];
  out: boolean;
}) {
  const styles = useStyles(makeStyles);
  if (!reactions) return null;
  const entries = Object.values(reactions || {});
  if (entries.length === 0) return null;
  const grouped = new Map<string, number>();
  for (const e of entries) {
    if (!e?.emoji) continue;
    grouped.set(e.emoji, (grouped.get(e.emoji) || 0) + 1);
  }
  if (grouped.size === 0) return null;
  const top = Array.from(grouped.entries()).slice(0, 4);
  return (
    <View
      style={[
        styles.reactionsPillRow,
        out ? styles.reactionsPillRowOut : styles.reactionsPillRowIn,
      ]}
    >
      <View style={styles.reactionsPill}>
        {top.map(([emoji, count], i) => (
          <Text key={i} style={styles.reactionsPillTxt}>
            {emoji}
            {count > 1 ? ` ${count}` : ""}
          </Text>
        ))}
      </View>
    </View>
  );
}

// v1.197 read receipts: ✓ (sent) → ✓✓ gray (delivered) → ✓✓ blue (read).
// Pre-197 messages that never advance past "sent" keep showing a single
// gray ✓ — no migration; the wider state machine is purely additive.
// Note: the prior implementation tinted "sent" blue, which read as "the
// customer saw this" even though we had no read-receipt signal. Now blue
// is reserved for actual read confirmations.
function Status({ status }: { status: Message["status"] }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  let txt = "✓";
  let color: string = colors.muted;
  if (status === "sending") {
    txt = "⏳";
  } else if (status === "failed") {
    txt = "✗";
    color = colors.red;
  } else if (status === "delivered") {
    txt = "✓✓";
  } else if (status === "read") {
    txt = "✓✓";
    color = "#53bdeb";
  }
  return <Text style={[styles.status, { color }]}>{txt}</Text>;
}

// v1.181: forward long-press from the media's inner TouchableOpacity to
// the parent bubble's onLongPress so the React/Reply/Forward/Edit/Delete
// menu opens on attachment bubbles just like it does on text bubbles.
// Without this, the inner Touchable captures the touch and the outer
// bubble's onLongPress never fires — Bhargav reported the action menu
// "is coming for chats, but not for attachments in team chat."
function MediaBlock({
  media,
  onLongPress,
  onImagePress,
}: {
  media?: Message["media"] | null;
  onLongPress: () => void;
  onImagePress?: (url: string) => void;
}) {
  const styles = useStyles(makeStyles);
  if (!media) return null;
  if (!media.url) {
    if (media.fileName) {
      return (
        <View style={styles.docBlock}>
          <Text style={styles.docTxt}>📎 {media.fileName}</Text>
        </View>
      );
    }
    return null;
  }
  const mt = String(media.mimeType || "").toLowerCase();
  const proxied = mediaProxyUrl(media.url);
  if (mt.startsWith("image")) {
    return (
      <TouchableOpacity
        onPress={() => {
          // v1.194: prefer the parent-supplied in-app viewer when wired
          // (Thread / DM screens). Falls back to Linking for any caller
          // that hasn't been updated yet (search results, etc.).
          if (onImagePress) onImagePress(media.url!);
          else Linking.openURL(proxied);
        }}
        onLongPress={onLongPress}
        delayLongPress={420}
      >
        <Image
          source={{ uri: proxied }}
          style={styles.image}
          resizeMode="cover"
        />
      </TouchableOpacity>
    );
  }
  if (mt.startsWith("video")) {
    return (
      <TouchableOpacity
        onPress={() => Linking.openURL(proxied)}
        onLongPress={onLongPress}
        delayLongPress={420}
        style={styles.docBlock}
      >
        <Text style={styles.docTxt}>🎥 {media.fileName || "Video"}</Text>
      </TouchableOpacity>
    );
  }
  if (mt.startsWith("audio")) {
    return (
      <TouchableOpacity
        onPress={() => Linking.openURL(proxied)}
        onLongPress={onLongPress}
        delayLongPress={420}
        style={styles.docBlock}
      >
        <Text style={styles.docTxt}>🎤 {media.fileName || "Voice note"}</Text>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity
      onPress={() => Linking.openURL(proxied)}
      onLongPress={onLongPress}
      delayLongPress={420}
      style={styles.docBlock}
    >
      <Text style={styles.docTxt}>📎 {media.fileName || "Attachment"}</Text>
    </TouchableOpacity>
  );
}

function formatClock(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function makeStyles(colors: Colors) {
  // Sender tag color — purple in dark mode (like the screenshot), dark
  // green in light mode for brand consistency with the existing palette.
  // Detected from the body bg fingerprint so we don't have to thread mode
  // through every call site.
  const senderTagColor = colors.bg === "#0a0e16" ? "#a78bfa" : "#008069";
  return StyleSheet.create({
    row: { paddingVertical: 2 },
    rowOut: { alignItems: "flex-end" },
    rowIn: { alignItems: "flex-start" },
    bubble: {
      maxWidth: "82%",
      paddingHorizontal: 9,
      paddingTop: 5,
      paddingBottom: 4,
      borderRadius: 7,
      shadowColor: "#0b141a",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.13,
      shadowRadius: 0.5,
      elevation: 1,
    },
    bubbleIn: {
      backgroundColor: colors.bubbleIn,
      borderTopLeftRadius: 0,
    },
    bubbleOut: {
      backgroundColor: colors.bubbleOut,
      borderTopRightRadius: 0,
    },
    senderTag: {
      fontSize: 11.5,
      fontWeight: "500",
      color: senderTagColor,
      marginBottom: 2,
    },
    text: { fontSize: 14.5, color: colors.text, lineHeight: 19 },
    footer: {
      flexDirection: "row",
      alignSelf: "flex-end",
      alignItems: "center",
      gap: 4,
      marginTop: 2,
    },
    clock: { fontSize: 10.5, color: colors.muted },
    status: { fontSize: 11 },
    // v1.151 deleted-message styling. Italic muted text + a slightly
    // washed-out bubble background so it reads as "tombstone" without
    // disappearing entirely.
    bubbleDeleted: { opacity: 0.7 },
    deletedTxt: {
      fontSize: 14,
      color: colors.muted,
      fontStyle: "italic",
      lineHeight: 19,
    },
    editedTag: {
      fontSize: 10.5,
      color: colors.muted,
      fontStyle: "italic",
    },
    // v1.152 reaction pill. Sits just under the bubble corner on the
    // same side as the bubble's tail (right for outbound, left for
    // inbound). The negative top margin slightly overlaps the bubble's
    // bottom edge, matching WhatsApp's tight placement.
    reactionsPillRow: { marginTop: -2 },
    reactionsPillRowOut: { alignItems: "flex-end", paddingRight: 6 },
    reactionsPillRowIn: { alignItems: "flex-start", paddingLeft: 6 },
    reactionsPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 12,
      backgroundColor: colors.panel,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    reactionsPillTxt: { fontSize: 12, color: colors.text },
    // v1.153 quoted card inside a reply bubble. Left accent stripe +
    // muted label + clipped snippet. Tinted background so it reads as
    // a distinct sub-block within the bubble.
    replyQuote: {
      borderLeftWidth: 3,
      borderLeftColor: senderTagColor,
      paddingLeft: 6,
      paddingVertical: 4,
      marginBottom: 4,
      backgroundColor: "rgba(0,0,0,0.06)",
      borderRadius: 4,
    },
    replyQuoteLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: senderTagColor,
    },
    replyQuoteTxt: {
      fontSize: 12.5,
      color: colors.muted,
      marginTop: 1,
    },
    // v1.154 "↪️ Forwarded from X" header. Italic + muted so it reads
    // as metadata, not as part of the message body.
    forwardedHeader: { marginBottom: 4 },
    forwardedTxt: {
      fontSize: 12,
      color: colors.muted,
      fontStyle: "italic",
    },
    image: {
      width: 220,
      height: 220,
      borderRadius: 4,
      marginBottom: 4,
      backgroundColor: "rgba(0,0,0,0.04)",
    },
    docBlock: {
      backgroundColor: "rgba(0,0,0,0.04)",
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 6,
      marginBottom: 4,
    },
    docTxt: { fontSize: 13, color: colors.text },
  });
}
