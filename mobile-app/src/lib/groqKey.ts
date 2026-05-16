// Per-user Groq API key store (v1.133). Each teammate creates a free Groq
// account, generates a key at console.groq.com/keys, and pastes it into the
// Settings screen. The key lives in AsyncStorage on-device — never uploaded
// to the Worker, never shared between teammates.
//
// Why AsyncStorage and not SecureStore: SecureStore requires adding a native
// module which forces a new EAS dev-client build. AsyncStorage is already a
// dependency and phones are personal/locked, so the practical threat model
// (someone else getting hold of an unlocked teammate's phone and digging
// into RN's storage) is low. If we ever start storing higher-value keys
// (customer card numbers, etc.) we'd upgrade to SecureStore.

import AsyncStorage from "@react-native-async-storage/async-storage";

const GROQ_KEY_AS = "cc.groqApiKey";

export async function getGroqKey(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(GROQ_KEY_AS)) || "";
  } catch {
    return "";
  }
}

export async function setGroqKey(key: string): Promise<void> {
  try {
    if (key) await AsyncStorage.setItem(GROQ_KEY_AS, key);
    else await AsyncStorage.removeItem(GROQ_KEY_AS);
  } catch {
    /* storage disabled — fail soft, the user just won't have a key set */
  }
}

// Probe Groq with /models — cheap auth-only call, no audio uploaded. Used by
// the Settings screen's "Test & save" button to surface typos / revoked keys
// immediately instead of failing at next voice-note tap.
export async function testGroqKey(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: "Bearer " + key },
    });
    if (res.ok) return { ok: true };
    const j = await res.json().catch(() => ({}));
    return { ok: false, error: j?.error?.message || `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
