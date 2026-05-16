// Single message bubble.
//   • Single tap     → onPress (parent opens "Create ticket" flow)
//   • Long-press     → onLongPress (parent copies text to clipboard)
// Mirrors the webapp's click-to-ticket / long-press-to-copy split.
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
import type { Message } from "@/types";

interface Props {
  message: Message;
  isGroup: boolean;
  resolveSenderName: (phone: string) => string;
  onPress: (m: Message) => void;
  onLongPress: (m: Message) => void;
}

export function MessageBubble({
  message: m,
  isGroup,
  resolveSenderName,
  onPress,
  onLongPress,
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

  // Detect "empty" messages: no text, no usable media. Periskope occasionally
  // sends these (reaction-only, deleted-for-me, system events). Without this
  // guard they render as ghost bubbles with just a timestamp — looks broken.
  const hasText = !!(m.text && m.text.trim());
  const hasMedia = !!(m.media && (m.media.url || m.media.fileName));
  if (!hasText && !hasMedia) {
    return null;
  }

  return (
    <View style={[styles.row, out ? styles.rowOut : styles.rowIn]}>
      <TouchableOpacity
        delayLongPress={420}
        onPress={() => onPress(m)}
        onLongPress={() => onLongPress(m)}
        activeOpacity={0.85}
        style={[styles.bubble, out ? styles.bubbleOut : styles.bubbleIn]}
      >
        {senderTag && <Text style={styles.senderTag}>{senderTag}</Text>}
        <MediaBlock media={m.media} />
        {hasText ? <Text style={styles.text}>{m.text}</Text> : null}
        <View style={styles.footer}>
          <Text style={styles.clock}>{formatClock(m.ts)}</Text>
          {out && <Status status={m.status} />}
        </View>
      </TouchableOpacity>
    </View>
  );
}

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
  } else {
    color = "#53bdeb";
  }
  return <Text style={[styles.status, { color }]}>{txt}</Text>;
}

function MediaBlock({ media }: { media?: Message["media"] | null }) {
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
      <TouchableOpacity onPress={() => Linking.openURL(proxied)}>
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
        style={styles.docBlock}
      >
        <Text style={styles.docTxt}>🎤 {media.fileName || "Voice note"}</Text>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity
      onPress={() => Linking.openURL(proxied)}
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
