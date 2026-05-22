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

// v1.236: SA session recording options. Higher bitrate than voice notes
// because (1) SAs run 30–60 min so the file IS the conversation record,
// not just a transcription crutch — trainers may listen back; (2) we have
// the budget for it at 48 kbps mono (≈ 21 MB / 60 min, well under Groq's
// 25 MB single-request cap so no chunking needed); (3) the slightly
// higher sample rate (22.05 kHz vs 16 kHz) gives Whisper a touch more
// signal in noisy gym environments without changing anything downstream.
//
// Per design conversation: mono only (single mic mix), no stereo channel
// separation — speaker labels are inferred later by AI consumers if/when
// needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeSaRecordingOptions(audioMod: any) {
  return {
    extension: ".m4a",
    sampleRate: 22050,
    numberOfChannels: 1,
    bitRate: 48000,
    android: {
      outputFormat: "mpeg4",
      audioEncoder: "aac",
    },
    ios: {
      outputFormat: audioMod.IOSOutputFormat.MPEG4AAC,
      audioQuality: audioMod.AudioQuality.MEDIUM,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
  };
}
