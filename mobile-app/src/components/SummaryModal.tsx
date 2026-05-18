// AI summary modal. Calls the Worker's /summarize, shows the result, lets
// the user regenerate. Discards stale responses if the thread was closed
// mid-flight so we don't render one chat's summary inside another.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { summarize } from "@/lib/worker";
import { useStyles, useTheme, type Colors } from "@/theme";

interface Props {
  visible: boolean;
  chatId: string | null;
  onClose: () => void;
}

export function SummaryModal({ visible, chatId, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [sub, setSub] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);

  const run = async () => {
    if (!chatId) return;
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setSummary(null);
    setError(null);
    setSub("Calling Claude via worker…");
    const j = await summarize(chatId);
    if (myReq !== reqIdRef.current) return;
    setLoading(false);
    if (j.error) {
      setError(j.error);
      setSub("");
      return;
    }
    setSummary(j.summary || "(empty)");
    setSub(`${j.count ?? 0} of ${j.total ?? 0} messages summarized`);
  };

  useEffect(() => {
    if (visible && chatId) run();
    return () => {
      reqIdRef.current++; // invalidate any in-flight request
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, chatId]);

  // v1.179: scroll-fix. Previously the card was wrapped in a Pressable
  // (with stopPropagation) so backdrop-taps wouldn't dismiss it. On iOS
  // that outer Pressable claimed the touch responder before the inner
  // ScrollView could grab the pan, so the summary text never scrolled.
  // New shape: a non-touch View for the layout root, a sibling
  // TouchableWithoutFeedback covering only the backdrop area for the
  // tap-to-close gesture, and a plain View for the card. ScrollView
  // gets its touches uncontested.
  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.back}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={StyleSheet.absoluteFill} />
        </TouchableWithoutFeedback>
        <View style={styles.card}>
          <Text style={styles.title}>Chat summary</Text>
          <Text style={styles.sub}>{sub}</Text>
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator
            keyboardShouldPersistTaps="handled"
          >
            {loading && (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.green} />
                <Text style={styles.thinking}>Thinking…</Text>
              </View>
            )}
            {error && <Text style={styles.error}>Failed: {error}</Text>}
            {summary && <Text style={styles.summary}>{summary}</Text>}
          </ScrollView>
          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.btn} onPress={run} disabled={loading}>
              <Text style={styles.btnTxt}>Regenerate</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={onClose}
            >
              <Text style={[styles.btnTxt, styles.btnTxtPrimary]}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
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
      // v1.179: stop the card from sitting flush against the screen edges
      // on small devices, and make sure the ScrollView inside has a hard
      // height to scroll inside rather than flex-growing.
      flexShrink: 1,
    },
    title: { fontSize: 17, fontWeight: "600", color: colors.text },
    sub: { fontSize: 12, color: colors.muted, marginBottom: 12, marginTop: 2 },
    // v1.179: drop maxHeight on the ScrollView. flexShrink:1 lets the body
    // claim whatever height the card has left after title/sub/buttons, so
    // longer summaries scroll inside that bounded region. The previous
    // fixed 360 worked on most screens but capped tall iPhones at ~half
    // the modal even when there was room for more.
    body: { flexShrink: 1, marginBottom: 12 },
    bodyContent: { paddingRight: 4 },
    loading: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
    thinking: { color: colors.muted, fontStyle: "italic" },
    summary: { fontSize: 14, color: colors.text, lineHeight: 21 },
    error: { color: colors.redDark, fontSize: 13 },
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
    btnTxt: { fontSize: 14, color: colors.text },
    btnTxtPrimary: { color: "white", fontWeight: "500" },
  });
}
