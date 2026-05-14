# CommonCommunication — mobile app

React Native (Expo, managed workflow) port of the WhatsApp-style mobile PWA.
Same backend (Cloudflare Worker + Firebase RTDB + Periskope) as the desktop
dashboard and the `mobile.html` PWA — clients just render different views of
the same data.

## What you need to set up before this can run

These steps are blocking and must happen on **your** side (Firebase /
Google / Apple consoles). I can't do them for you.

### 1. Firebase Console (existing `motherofdashboard` project)

- **Add iOS app**: bundle id `com.aroleap.commoncomm`. Download
  `GoogleService-Info.plist` (we don't commit it; copy into the EAS dashboard
  when prompted, or run `eas credentials` later).
- **Add Android app**: package name `com.aroleap.commoncomm`. Download
  `google-services.json`.
- **Authentication → Sign-in method → Google**: enable it. Add OAuth client
  IDs for iOS and Android (Firebase will guide you, and the iOS one needs the
  `GoogleService-Info.plist` reverse-client ID matching your bundle id).
- **Cloud Messaging**: under Project settings → Cloud Messaging, note the
  server key (Android FCM). For iOS, upload an **APNs auth key** (`.p8`)
  generated at developer.apple.com → Certificates → Keys.

Copy the three OAuth client IDs (iOS / Android / Web) into
`mobile-app/app.json` under `extra.googleSignIn`. Replace the
`REPLACE_WITH_…` placeholders.

### 2. Expo account

- Sign up at https://expo.dev (free).
- `npm install -g eas-cli && eas login`
- From `mobile-app/`, run `eas init` — it'll create a project and write the
  `eas.projectId` into `app.json`. Replace the placeholder there.

### 3. Apple Developer & Play Console

- Apple Developer Program — needed for TestFlight and APNs.
- Google Play Console (optional; you can sideload an `.apk` if skipping).

### 4. Worker secret

```
cd ..    # repo root
wrangler secret put EXPO_ACCESS_TOKEN   # optional, raises push rate limits
```

The Worker is already deployed with `/register-push-token` and inbound-
message fan-out. No redeploy needed once you `wrangler deploy` with the new
`worker.js`.

## Running locally

```bash
cd mobile-app
npm install
npx expo start
```

Scan the QR with **Expo Go** (Android) or the **Expo Go** app (iOS) on a
device on the same Wi-Fi. Sign in with a Google account that's in
`commonComm/config/allowedEmails` (or one of the BOOTSTRAP_ADMINS).

Note: Google sign-in via `expo-auth-session` requires the OAuth client IDs
from step 1 above. Until those are filled in, sign-in will fail.

## Building a real install

```bash
# First build, internal distribution (no app-store review):
eas build --profile preview --platform android
eas build --profile preview --platform ios

# Then submit:
eas submit --platform android
eas submit --platform ios
```

## File layout

```
mobile-app/
├── App.tsx                    # auth gate + navigation
├── index.ts                   # entry, registers App with Expo
├── app.json / eas.json        # Expo + EAS config
├── package.json
└── src/
    ├── config.ts              # Firebase config, Worker URL, constants
    ├── theme.ts               # colors / spacing — matches mobile.html
    ├── types.ts               # data shapes
    ├── firebase.ts            # Firebase init w/ AsyncStorage persistence
    ├── auth/                  # AuthProvider + LoginScreen
    ├── data/                  # AppDataProvider (chats / tickets / ferra)
    ├── lib/                   # name resolution, format, worker, encodeKey
    ├── notifications/         # Expo push token registration
    ├── screens/               # ChatsScreen, TicketsScreen, ThreadScreen
    └── components/            # rows, modals, banner, filter bar
```

## What this app does (same as the PWA)

- Google sign-in with the same allowlist as desktop
- Chats list with subscription / stage filters + name + phone search
- Daily-Workout cohort groups clubbed under a single "Daily groups" option
  (hidden by default)
- Thread view with text, image / video / audio / document send + caption
- Long-press a message → create ticket, copy text
- My-tickets tab with read + Resolve (with confirm) + Reassign
- ✨ AI summary via Claude (through the Worker)
- Push notifications for inbound messages (via Expo Push Service)

## What's intentionally NOT in v1

- Editing / deleting messages
- Private notes (admin feature on desktop only)
- Backfill / Names admin / Templates / customer browser
- AI suggested-reply button (the desktop has it; can add later)

## Caveats

- **Firebase JS SDK** is used instead of `@react-native-firebase/*`. That
  keeps us on the Expo managed workflow (no `expo prebuild` needed) at the
  cost of slightly worse cold-start vs the native modules. We can migrate
  later if perf becomes an issue.
- **Push** is broadcast to every signed-in agent on every inbound message.
  Once the team is bigger and this becomes noisy, filter on tickets owned /
  recently active senders in `fanoutPush` in `worker.js`.
- The "extra.googleSignIn.*" client IDs in `app.json` MUST be filled before
  sign-in will work. They're not secrets but they tie the build to your
  Firebase project.
