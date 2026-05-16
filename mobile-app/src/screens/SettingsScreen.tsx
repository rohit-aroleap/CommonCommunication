// Settings screen. Holds:
//   • Appearance toggle (light / dark, default dark — v1.136)
//   • Per-user Groq API key for fast voice-note transcription (v1.133)
//
// The appearance toggle drives the ThemeProvider hooked up in App.tsx; the
// preference is persisted under "cc.appearance" so it survives reloads /
// OTA updates / app restarts.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { space, useStyles, useTheme, type Colors } from "@/theme";
import { getGroqKey, setGroqKey, testGroqKey } from "@/lib/groqKey";

export function SettingsScreen() {
  const [key, setKey] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<
    { kind: "idle" | "ok" | "error"; msg: string }
  >({ kind: "idle", msg: "" });
  const { colors, mode, setMode } = useTheme();
  const styles = useStyles(makeStyles);

  useEffect(() => {
    getGroqKey().then((k) => {
      setKey(k);
      setSavedKey(k);
    });
  }, []);

  const dirty = key.trim() !== savedKey;
  const hasSaved = savedKey.length > 0;

  async function onSave() {
    const trimmed = key.trim();
    if (!trimmed) {
      setStatus({ kind: "error", msg: "Paste a key first." });
      return;
    }
    if (!trimmed.startsWith("gsk_")) {
      setStatus({
        kind: "error",
        msg: "That doesn't look like a Groq key (should start with gsk_).",
      });
      return;
    }
    setTesting(true);
    setStatus({ kind: "idle", msg: "Testing…" });
    const result = await testGroqKey(trimmed);
    if (!result.ok) {
      setStatus({ kind: "error", msg: "Test failed: " + result.error });
      setTesting(false);
      return;
    }
    await setGroqKey(trimmed);
    setSavedKey(trimmed);
    setStatus({
      kind: "ok",
      msg: "Saved — voice notes will use your Groq key.",
    });
    setTesting(false);
  }

  function onClear() {
    Alert.alert(
      "Remove Groq key?",
      "Voice notes will fall back to the slower Worker path until you add a key again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await setGroqKey("");
            setKey("");
            setSavedKey("");
            setStatus({ kind: "idle", msg: "Key removed." });
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* v1.136: appearance toggle. Default is dark; switch flips to
            light. Each option is a half-pill that visually shows which
            mode is active. Theme changes apply instantly app-wide. */}
        <Text style={styles.section}>APPEARANCE</Text>
        <View style={styles.themeToggle}>
          <TouchableOpacity
            style={[
              styles.themeOpt,
              mode === "light" && styles.themeOptActive,
            ]}
            onPress={() => setMode("light")}
            accessibilityLabel="Use light appearance"
          >
            <Text style={styles.themeOptGlyph}>☀</Text>
            <Text
              style={[
                styles.themeOptTxt,
                mode === "light" && styles.themeOptTxtActive,
              ]}
            >
              Light
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.themeOpt,
              mode === "dark" && styles.themeOptActive,
            ]}
            onPress={() => setMode("dark")}
            accessibilityLabel="Use dark appearance"
          >
            <Text style={styles.themeOptGlyph}>🌙</Text>
            <Text
              style={[
                styles.themeOptTxt,
                mode === "dark" && styles.themeOptTxtActive,
              ]}
            >
              Dark
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.helpFoot}>
          Dark is the default. Pick whichever your eyes prefer — saved on
          this device.
        </Text>

        <View style={styles.divider} />

        <Text style={styles.section}>VOICE NOTES</Text>
        <Text style={styles.blurb}>
          Add your own Groq API key for fast voice-note transcription. Each
          teammate gets a free account (8 hours of audio per day).
        </Text>

        <View style={styles.row}>
          <Text style={styles.label}>Groq API key</Text>
          <TouchableOpacity
            onPress={() => Linking.openURL("https://console.groq.com/keys")}
          >
            <Text style={styles.linkRight}>Get a key →</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.inputRow}>
          <TextInput
            value={key}
            onChangeText={(t) => {
              setKey(t);
              if (status.kind !== "idle")
                setStatus({ kind: "idle", msg: "" });
            }}
            placeholder="gsk_..."
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            secureTextEntry={!revealed}
            style={styles.input}
          />
          <TouchableOpacity
            onPress={() => setRevealed((v) => !v)}
            style={styles.eyeBtn}
            accessibilityLabel={revealed ? "Hide key" : "Show key"}
          >
            <Text style={styles.eyeTxt}>{revealed ? "🙈" : "👁"}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.statusBox}>
          {testing ? (
            <View style={styles.statusInline}>
              <ActivityIndicator size="small" color={colors.muted} />
              <Text style={styles.statusMuted}> Testing…</Text>
            </View>
          ) : status.kind === "ok" ? (
            <Text style={styles.statusOk}>● {status.msg}</Text>
          ) : status.kind === "error" ? (
            <Text style={styles.statusErr}>{status.msg}</Text>
          ) : hasSaved && !dirty ? (
            <Text style={styles.statusOk}>● Saved — using your Groq key.</Text>
          ) : (
            <Text style={styles.statusMuted}>
              No key saved — using the slower Worker fallback.
            </Text>
          )}
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            onPress={onClear}
            disabled={!hasSaved}
            style={[styles.btn, styles.btnSecondary, !hasSaved && styles.btnDisabled]}
          >
            <Text style={[styles.btnTxt, !hasSaved && styles.btnTxtDisabled]}>
              Remove key
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onSave}
            disabled={testing || !dirty}
            style={[styles.btn, styles.btnPrimary, (testing || !dirty) && styles.btnDisabled]}
          >
            <Text style={[styles.btnTxt, styles.btnTxtPrimary]}>
              {testing ? "Testing…" : "Test & save"}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.helpHead}>How do I get a free Groq key?</Text>
        <Text style={styles.helpStep}>
          1. Sign up at console.groq.com (free, no card)
        </Text>
        <Text style={styles.helpStep}>
          2. Open API Keys → Create API Key
        </Text>
        <Text style={styles.helpStep}>
          3. Copy the gsk_… string and paste it above
        </Text>
        <Text style={styles.helpStep}>4. Tap Test &amp; save</Text>
        <Text style={styles.helpFoot}>
          Your key is stored on this phone only. It's never uploaded to our
          Worker or shared with other teammates.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    scroll: { flex: 1 },
    content: { padding: space.lg, paddingBottom: space.xl * 2 },
    section: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.muted,
      letterSpacing: 0.6,
      marginBottom: space.sm,
    },
    blurb: {
      fontSize: 13,
      color: colors.muted,
      lineHeight: 18,
      marginBottom: space.lg,
    },
    themeToggle: {
      flexDirection: "row",
      gap: 8,
      marginBottom: space.sm,
    },
    themeOpt: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: colors.panel,
      borderWidth: 1,
      borderColor: colors.border,
    },
    themeOptActive: {
      backgroundColor: colors.pillActiveBg,
      borderColor: colors.green,
    },
    themeOptGlyph: { fontSize: 18 },
    themeOptTxt: { fontSize: 14, fontWeight: "500", color: colors.text },
    themeOptTxtActive: { color: colors.pillActiveFg, fontWeight: "600" },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginVertical: space.lg,
    },
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: space.xs,
    },
    label: { fontSize: 13, fontWeight: "600", color: colors.text },
    linkRight: { fontSize: 12, color: colors.green },
    inputRow: { flexDirection: "row", alignItems: "center", marginBottom: space.sm },
    input: {
      flex: 1,
      backgroundColor: colors.panel,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      fontFamily: "Courier",
      color: colors.text,
    },
    eyeBtn: {
      width: 44,
      height: 44,
      marginLeft: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.panel,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
    },
    eyeTxt: { fontSize: 18 },
    statusBox: { minHeight: 24, marginBottom: space.md },
    statusInline: { flexDirection: "row", alignItems: "center" },
    statusOk: { color: "#34d399", fontSize: 13 },
    statusErr: { color: "#f87171", fontSize: 13 },
    statusMuted: { color: colors.muted, fontSize: 13 },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 10,
      marginBottom: space.xl,
    },
    btn: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 8,
      minWidth: 110,
      alignItems: "center",
    },
    btnPrimary: { backgroundColor: colors.green },
    btnSecondary: {
      backgroundColor: colors.panel,
      borderWidth: 1,
      borderColor: colors.border,
    },
    btnDisabled: { opacity: 0.5 },
    btnTxt: { fontSize: 14, fontWeight: "600", color: colors.text },
    btnTxtPrimary: { color: "white" },
    btnTxtDisabled: { color: colors.muted },
    helpHead: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.text,
      marginBottom: space.sm,
    },
    helpStep: { fontSize: 13, color: colors.muted, lineHeight: 22 },
    helpFoot: {
      fontSize: 12,
      color: colors.muted,
      lineHeight: 18,
      marginTop: space.md,
      fontStyle: "italic",
    },
  });
}
