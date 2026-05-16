// Sign-in screen. Two paths:
//   1. Google sign-in via expo-auth-session (id_token flow). Works in many
//      environments but Google has been hostile to native custom-URI-scheme
//      flows on Android since 2022 — it may show "Custom URI scheme not
//      enabled" errors. When that happens, fall through to:
//   2. Email/password sign-in via Firebase Auth — same accounts as the
//      desktop dashboard. Admin creates accounts in Firebase Console →
//      Authentication → Users → Add user.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import { useAuth } from "./AuthContext";
import { GOOGLE_OAUTH } from "@/config";
import { useStyles, useTheme, type Colors } from "@/theme";
import { getDisplayVersion } from "@/lib/version";

WebBrowser.maybeCompleteAuthSession();

export function LoginScreen() {
  const {
    signInWithGoogleIdToken,
    signInWithEmailPassword,
    status,
    unauthorizedEmail,
  } = useAuth();
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailSigningIn, setEmailSigningIn] = useState(false);

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: GOOGLE_OAUTH.iosClientId,
    androidClientId: GOOGLE_OAUTH.androidClientId,
    webClientId: GOOGLE_OAUTH.webClientId,
  });

  useEffect(() => {
    if (!response) return;
    if (response.type === "success") {
      const idToken = response.params?.id_token;
      if (!idToken) {
        setError("Sign-in returned no id_token");
        setSigningIn(false);
        return;
      }
      signInWithGoogleIdToken(idToken).catch((e) => {
        setError(`Firebase sign-in failed: ${e?.message ?? e}`);
        setSigningIn(false);
      });
    } else if (response.type === "error") {
      setError(response.error?.message ?? "Sign-in failed");
      setSigningIn(false);
    } else if (response.type === "dismiss" || response.type === "cancel") {
      setSigningIn(false);
    }
  }, [response, signInWithGoogleIdToken]);

  const onGooglePress = async () => {
    setError(null);
    setSigningIn(true);
    try {
      await promptAsync();
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed");
      setSigningIn(false);
    }
  };

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

        <TouchableOpacity
          style={[styles.btnGoogle, (!request || signingIn) && styles.btnDisabled]}
          onPress={onGooglePress}
          disabled={!request || signingIn}
        >
          {signingIn || status === "checking-allowlist" ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <>
              <Image
                source={{
                  uri: "https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg",
                }}
                style={styles.googleIcon}
              />
              <Text style={styles.btnGoogleText}>Sign in with Google</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or sign in with email</Text>
          <View style={styles.dividerLine} />
        </View>

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
          {emailSigningIn ? (
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
    btnGoogle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 20,
      justifyContent: "center",
      width: "100%",
      minHeight: 48,
    },
    btnDisabled: { opacity: 0.6 },
    btnGoogleText: { fontSize: 14, fontWeight: "500", color: colors.text },
    googleIcon: { width: 18, height: 18 },
    divider: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      width: "100%",
      marginVertical: 16,
    },
    dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
    dividerText: { fontSize: 11, color: colors.muted },
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
    version: { color: colors.muted, fontSize: 11, marginTop: 18 },
  });
}
