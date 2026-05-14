// Google sign-in via expo-auth-session. We request an ID token (not access
// token) because Firebase's GoogleAuthProvider.credential() wants the ID
// token. The three client IDs (iOS / Android / Web) must be set in app.json
// "extra.googleSignIn" and configured in Firebase Console → Authentication
// → Google.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import { useAuth } from "./AuthContext";
import { GOOGLE_OAUTH } from "@/config";
import { colors } from "@/theme";

WebBrowser.maybeCompleteAuthSession();

export function LoginScreen() {
  const { signInWithGoogleIdToken, status, unauthorizedEmail } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

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

  const onPress = async () => {
    setError(null);
    setSigningIn(true);
    try {
      await promptAsync();
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed");
      setSigningIn(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.title}>CommonCommunication</Text>
        <Text style={styles.sub}>Aroleap shared customer inbox</Text>
        <TouchableOpacity
          style={[styles.btn, (!request || signingIn) && styles.btnDisabled]}
          onPress={onPress}
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
              <Text style={styles.btnText}>Sign in with Google</Text>
            </>
          )}
        </TouchableOpacity>
        {status === "unauthorized" && unauthorizedEmail && (
          <Text style={styles.error}>
            {unauthorizedEmail} is not in the allowlist. Ask an admin to add
            you.
          </Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <Text style={styles.version}>Mobile · v0.1</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.greenDark,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    backgroundColor: "white",
    borderRadius: 16,
    padding: 28,
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
  },
  title: { fontSize: 20, fontWeight: "600", color: colors.text, marginBottom: 4 },
  sub: { fontSize: 13, color: colors.muted, marginBottom: 24 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "white",
    borderColor: "#dadce0",
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 20,
    justifyContent: "center",
    minWidth: 220,
    minHeight: 48,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { fontSize: 14, fontWeight: "500", color: colors.text },
  googleIcon: { width: 18, height: 18 },
  error: { color: colors.redDark, fontSize: 12, marginTop: 12, textAlign: "center" },
  version: { color: "#99a5ad", fontSize: 11, marginTop: 18 },
});
