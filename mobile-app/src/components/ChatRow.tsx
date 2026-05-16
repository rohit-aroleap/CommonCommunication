// Chat list row. Shows avatar (red when the chat has an open ticket
// assigned to the current user), name, last-message preview, time, plus
// optional subscription-status and stage pills. Matches the WhatsApp-style
// layout in mobile.html.

import React from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";
import { space, useStyles, useTheme, type Colors } from "@/theme";
import type { ChatRow as ChatRowT } from "@/types";

interface Props {
  row: ChatRowT;
  name: string;
  subscriptionStatus: string | null;
  stage: string | null;
  hasOpenTicket: boolean;
  myTicket: boolean;
  unread: boolean;
  isFavorite: boolean;
  suggestPin: boolean;
  onPress: () => void;
  onToggleFavorite: () => void;
}

export function ChatRowItem({
  row,
  name,
  subscriptionStatus,
  stage,
  hasOpenTicket,
  myTicket,
  unread,
  isFavorite,
  suggestPin,
  onPress,
  onToggleFavorite,
}: Props) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const isGroup = row.chatType === "group";
  const avatarBg: ViewStyle = {
    backgroundColor: hasOpenTicket
      ? colors.red
      : isGroup
      ? "#6b7280"
      : colors.green,
  };
  const avatarChar = isGroup ? "👥" : initial(name);

  const previewPrefix =
    row.direction === "out" && row.sentByName
      ? `${row.sentByName}: `
      : "";

  const time = formatTime(row.lastMsgAt);

  // Stop propagation so tapping the star/Pin? button doesn't open the thread.
  const onStarPress = (e: { stopPropagation?: () => void }) => {
    e.stopPropagation?.();
    onToggleFavorite();
  };

  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.6}>
      <View style={[styles.avatar, avatarBg]}>
        <Text style={styles.avatarTxt}>{avatarChar}</Text>
      </View>
      <View style={styles.col}>
        <View style={styles.topLine}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.time}>{time}</Text>
        </View>
        <View style={styles.bottomLine}>
          <Text
            style={[styles.preview, unread && styles.previewUnread]}
            numberOfLines={1}
          >
            {previewPrefix
              ? <Text style={styles.previewWho}>{previewPrefix}</Text>
              : null}
            {row.preview || "No messages yet"}
          </Text>
          <View style={styles.badges}>
            {myTicket && (
              <View style={styles.ticketDot}>
                <Text style={styles.ticketDotTxt}>🎫</Text>
              </View>
            )}
            {subscriptionStatus === "ACTIVE" && (
              <Pill bg={colors.pillActiveBg} fg={colors.pillActiveFg} styles={styles}>
                Active
              </Pill>
            )}
            {subscriptionStatus === "CANCELLED" && (
              <Pill bg={colors.pillCancelledBg} fg={colors.pillCancelledFg} styles={styles}>
                Cancelled
              </Pill>
            )}
            {subscriptionStatus === "PAUSED" && (
              <Pill bg={colors.pillPausedBg} fg={colors.pillPausedFg} styles={styles}>
                Paused
              </Pill>
            )}
            {stage && stage !== "active" && (
              <StagePill stage={stage} colors={colors} styles={styles} />
            )}
            <StarButton
              isFavorite={isFavorite}
              suggestPin={!isFavorite && suggestPin}
              onPress={onStarPress}
              styles={styles}
            />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

type ChatRowStyles = ReturnType<typeof makeStyles>;

function StarButton({
  isFavorite,
  suggestPin,
  onPress,
  styles,
}: {
  isFavorite: boolean;
  suggestPin: boolean;
  onPress: (e: { stopPropagation?: () => void }) => void;
  styles: ChatRowStyles;
}) {
  if (suggestPin) {
    return (
      <TouchableOpacity
        accessibilityLabel="Pin this chat to favorites"
        onPress={onPress}
        hitSlop={8}
        style={styles.suggestPill}
      >
        <Text style={styles.suggestTxt}>☆ Pin?</Text>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity
      accessibilityLabel={
        isFavorite ? "Remove from favorites" : "Add to favorites"
      }
      onPress={onPress}
      hitSlop={8}
      style={styles.starBtn}
    >
      <Text
        style={[
          styles.starTxt,
          isFavorite ? styles.starTxtOn : styles.starTxtOff,
        ]}
      >
        {isFavorite ? "★" : "☆"}
      </Text>
    </TouchableOpacity>
  );
}

function Pill({
  bg,
  fg,
  styles,
  children,
}: {
  bg: string;
  fg: string;
  styles: ChatRowStyles;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillTxt, { color: fg }]}>{children}</Text>
    </View>
  );
}

function StagePill({
  stage,
  colors,
  styles,
}: {
  stage: string;
  colors: Colors;
  styles: ChatRowStyles;
}) {
  const map: Record<string, { bg: string; fg: string }> = {
    setup: { bg: colors.pillStageSetupBg, fg: colors.pillStageSetupFg },
    onboarding: {
      bg: colors.pillStageOnboardingBg,
      fg: colors.pillStageOnboardingFg,
    },
    sa: { bg: colors.pillStageSaBg, fg: colors.pillStageSaFg },
    offboarding: {
      bg: colors.pillStageOffboardingBg,
      fg: colors.pillStageOffboardingFg,
    },
  };
  const c = map[stage] ?? { bg: colors.border, fg: colors.muted };
  const label = stage[0].toUpperCase() + stage.slice(1);
  return <Pill bg={c.bg} fg={c.fg} styles={styles}>{label}</Pill>;
}

function initial(name: string): string {
  return (
    String(name || "?")
      .replace(/[()]/g, "")
      .trim()
      .charAt(0)
      .toUpperCase() || "?"
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

function makeStyles(colors: Colors) {
  return StyleSheet.create({
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
    previewWho: { color: colors.green, fontWeight: "500" },
    badges: {
      flexDirection: "row",
      gap: 4,
      alignItems: "center",
      marginLeft: space.sm,
    },
    pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 },
    pillTxt: { fontSize: 10, fontWeight: "500" },
    ticketDot: {
      backgroundColor: colors.red,
      borderRadius: 10,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    ticketDotTxt: { color: "white", fontSize: 11, fontWeight: "600" },
    starBtn: { paddingHorizontal: 4, paddingVertical: 2 },
    starTxt: { fontSize: 18, lineHeight: 20 },
    starTxtOn: { color: "#f5b50a" },
    starTxtOff: { color: colors.muted },
    suggestPill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 10,
      backgroundColor: "#fff7e0",
      borderWidth: 1,
      borderColor: "#f5b50a",
    },
    suggestTxt: { color: "#8a6500", fontSize: 11, fontWeight: "600" },
  });
}
