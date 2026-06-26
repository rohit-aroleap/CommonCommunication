// Whisper-tuned recording options. expo-audio's RecordingPresets.HIGH_QUALITY
// captures stereo 44.1 kHz @ 128 kbps (~1 MB/min). Whisper resamples
// everything to 16 kHz mono before transcription, so the extra fidelity is
// wasted upload bandwidth — particularly on mobile where the multipart
// upload to Groq is the slowest step. Using these settings instead cuts the
// file ~8× and brings mobile transcription latency in line with the web
// dashboard (which records at ~64 kbps webm/opus).
//
// Built lazily (takes audioMod as an arg) because expo-audio is lazy-required
// in the calling screens — see the `try { require("expo-audio") }` guard at
// the top of ThreadScreen / CustomerInfoScreen, which keeps the app working
// on native builds shipped before expo-audio existed.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeVoiceNoteRecordingOptions(audioMod: any) {
  return {
    extension: ".m4a",
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
    android: {
      outputFormat: "mpeg4",
      audioEncoder: "aac",
    },
    ios: {
      outputFormat: audioMod.IOSOutputFormat.MPEG4AAC,
      audioQuality: audioMod.AudioQuality.LOW,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
  };
}

// v1.249 — SA session recording options. Lowered bitrate from 48 → 24 kbps
// so a 2-hour SA fits Groq's 25 MB transcription cap WITHOUT needing any
// in-app splitting. Math: 24 kbps × 60 min = 10.8 MB/hr → 21.6 MB at 2 hr.
// Whisper resamples to 16 kHz mono anyway, so the quality drop is
// transcription-invisible. Trainers replaying recordings on-device will
// hear the bitrate drop slightly (voice is still very clear, just less
// "crisp"), but the local-only flow means replay only happens on the
// recording tablet so this is a fine trade.
//
// Sample rate stays at 22.05 kHz — slightly above 16 kHz so Whisper has
// a touch more signal to chew on in noisy gym environments.
//
// Hard recording cap in the SA modal is 130 minutes — that's ~23.4 MB at
// 24 kbps, leaving 1.6 MB of slack under Groq's 25 MB limit for variable-
// bitrate AAC overhead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeSaRecordingOptions(audioMod: any) {
  return {
    extension: ".m4a",
    sampleRate: 22050,
    numberOfChannels: 1,
    bitRate: 24000,
    // v1.338: surface live input level (dB) in the recorder status so the SA
    // modal can draw a mic waveform — a flat line tells the trainer the mic
    // isn't picking anything up. Negligible overhead.
    isMeteringEnabled: true,
    android: {
      outputFormat: "mpeg4",
      audioEncoder: "aac",
    },
    ios: {
      outputFormat: audioMod.IOSOutputFormat.MPEG4AAC,
      audioQuality: audioMod.AudioQuality.LOW,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
  };
}
