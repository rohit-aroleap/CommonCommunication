// AI summary modal. Calls the Worker's /summarize, shows the result, lets
// the user regenerate. Discards stale responses if the thread was closed
// mid-flight so we don't render one chat's summary inside another.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { summarize } from "@/lib/worker";
import { colors } from "@/theme";

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

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.back} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>Chat summary</Text>
          <Text style={styles.sub}>{sub}</Text>
          <ScrollView style={styles.body}>
            {loading && (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.greenDark} />
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
  body: { maxHeight: 360, marginBottom: 12 },
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
