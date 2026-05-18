// Sign-in screen — email/password only.
//
// v1.168: Google sign-in via expo-auth-session was removed. Native
// Google sign-in on Android requires a SHA-1 fingerprint registered
// against a specific OAuth client ID in Google Cloud, and the
// id_token flow from expo-auth-session also hits Google's hostility
// toward custom-URI-scheme flows since 2022. Both combined to make
// the button crash the Android app whenever a trainer tapped it. We
// never had a working Google path on either mobile platform, so the
// clean fix is to drop it and route everyone through email/password
// — same accounts as the desktop dashboard (Firebase Auth →
// Authentication → Users). Admin can create new users from the
// Firebase Console.
//
// The signInWithGoogleIdToken function is kept on AuthContext for
// any future re-enable (desktop still uses Google sign-in), this
// screen just no longer triggers it.

import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "./AuthContext";
import { useStyles, useTheme, type Colors } from "@/theme";
import { getDisplayVersion } from "@/lib/version";

export function LoginScreen() {
  const { signInWithEmailPassword, status, unauthorizedEmail } = useAuth();
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailSigningIn, setEmailSigningIn] = useState(false);

  const onEmailPress = async () => {
    if (!email.trim() || !password) return;
    setError(null);
    setEmailSigningIn(true);
    try {
      await signInWithEmailPassword(email, password);
      // onAuthStateChanged handles the rest (allowlist check, gating)
    } catch (e: any) {
      const code = e?.code || "";
      let msg = e?.message || "Sign-in failed";
      if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
        msg = "Wrong email or password.";
      } else if (code === "auth/too-many-requests") {
        msg = "Too many attempts — try again in a minute.";
      } else if (code === "auth/operation-not-allowed") {
        msg = "Email/password sign-in isn't enabled in Firebase.";
      } else if (code === "auth/invalid-email") {
        msg = "Invalid email address.";
      }
      setError(msg);
      setPassword("");
    } finally {
      setEmailSigningIn(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>CommonCommunication</Text>
        <Text style={styles.sub}>Aroleap shared customer inbox</Text>

        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="email@example.com"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          editable={!emailSigningIn}
        />
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="password"
          placeholderTextColor={colors.muted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          editable={!emailSigningIn}
          onSubmitEditing={onEmailPress}
        />
        <TouchableOpacity
          style={[styles.btnEmail, emailSigningIn && styles.btnDisabled]}
          onPress={onEmailPress}
          disabled={emailSigningIn || !email.trim() || !password}
        >
          {emailSigningIn || status === "checking-allowlist" ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={styles.btnEmailText}>Sign in</Text>
          )}
        </TouchableOpacity>

        {status === "unauthorized" && unauthorizedEmail && (
          <Text style={styles.error}>
            {unauthorizedEmail} is not in the allowlist. Ask an admin to add
            you.
          </Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.hint}>
          Need access? Ask an admin to create a Firebase Auth user for your
          email.
        </Text>
        <Text style={styles.version}>{getDisplayVersion()}</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.header,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      backgroundColor: colors.panel,
      borderRadius: 16,
      padding: 28,
      width: "100%",
      maxWidth: 360,
      alignItems: "center",
    },
    title: { fontSize: 20, fontWeight: "600", color: colors.text, marginBottom: 4 },
    sub: { fontSize: 13, color: colors.muted, marginBottom: 24 },
    btnDisabled: { opacity: 0.6 },
    input: {
      width: "100%",
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      paddingVertical: 10,
      paddingHorizontal: 12,
      fontSize: 13,
      color: colors.text,
      marginBottom: 8,
      backgroundColor: colors.panel,
    },
    btnEmail: {
      width: "100%",
      backgroundColor: colors.green,
      borderRadius: 6,
      paddingVertical: 11,
      alignItems: "center",
      marginTop: 4,
      minHeight: 44,
      justifyContent: "center",
    },
    btnEmailText: { color: "white", fontWeight: "600", fontSize: 14 },
    error: { color: colors.redDark, fontSize: 12, marginTop: 12, textAlign: "center" },
    hint: {
      color: colors.muted,
      fontSize: 11,
      marginTop: 14,
      textAlign: "center",
      lineHeight: 16,
    },
    version: { color: colors.muted, fontSize: 11, marginTop: 18 },
  });
}
