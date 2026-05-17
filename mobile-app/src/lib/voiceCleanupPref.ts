// Per-device voice-cleanup pref. When false, transcribeAudio skips the
// Claude tidy-up pass on every path (Groq-direct and Worker fallback) — the
// raw Whisper output is what the user sees. Default: true, so existing
// behaviour is unchanged for anyone who hasn't touched the toggle.
//
// Lives in AsyncStorage alongside the other "cc.*" prefs; same threat-model
// reasoning as groqKey.ts (personal device, low-value data).

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "cc.voiceCleanup";

export async function getVoiceCleanupEnabled(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v === null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

export async function setVoiceCleanupEnabled(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage disabled — fail soft */
  }
}
