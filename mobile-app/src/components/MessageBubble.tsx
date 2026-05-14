// Single message bubble. Long-press opens the parent's action sheet via the
// onLongPress callback. Media is rendered through the Worker's /media proxy
// because Periskope-hosted URLs require auth headers we can't attach to a
// plain <Image>.

import React from "react";
import {
  Image,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, space } from "@/theme";
import { mediaProxyUrl } from "@/lib/worker";
import type { Message } from "@/types";

interface Props {
  message: Message;
  isGroup: boolean;
  resolveSenderName: (phone: string) => string;
  onLongPress: (m: Message) => void;
}

export function MessageBubble({
  message: m,
  isGroup,
  resolveSenderName,
  onLongPress,
}: Props) {
  const out = m.direction === "out";
  const senderTag = out
    ? m.sentByName
      ? `— ${m.sentByName}`
      : null
    : isGroup && m.senderPhone
    ? `~ ${resolveSenderName(m.senderPhone)}`
    : null;

  return (
    <View style={[styles.row, out ? styles.rowOut : styles.rowIn]}>
      <TouchableOpacity
        delayLongPress={420}
        onLongPress={() => onLongPress(m)}
        activeOpacity={0.85}
        style={[styles.bubble, out ? styles.bubbleOut : styles.bubbleIn]}
      >
        {senderTag && <Text style={styles.senderTag}>{senderTag}</Text>}
        <MediaBlock media={m.media} />
        {m.text ? <Text style={styles.text}>{m.text}</Text> : null}
        <View style={styles.footer}>
          <Text style={styles.clock}>{formatClock(m.ts)}</Text>
          {out && <Status status={m.status} />}
        </View>
      </TouchableOpacity>
    </View>
  );
}

function Status({ status }: { status: Message["status"] }) {
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

const styles = StyleSheet.create({
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
    color: colors.greenDark,
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
