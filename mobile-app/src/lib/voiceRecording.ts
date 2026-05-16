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
