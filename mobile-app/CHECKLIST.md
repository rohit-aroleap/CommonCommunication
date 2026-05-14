# First-run checklist (when you sit down at your computer)

Ordered. Each step is independent of the next unless noted. Approximate
times are wall-clock if nothing fights you.

## Phase A — accounts (~30 min, mostly waiting)

- [ ] **Apple Developer Program** — enroll at developer.apple.com. $99/yr.
      Approval is usually same-day for individual accounts, can take 1-2
      days for org accounts. Needed for TestFlight + APNs.
- [ ] **Play Console** — pay$25 one-time at play.google.com/console.
      Optional if you only want to sideload `.apk` builds.
- [ ] **Expo account** — sign up at expo.dev. Free tier is fine.

## Phase B — Firebase Console (~10 min, needs `motherofdashboard` access)

- [ ] In Firebase Console → Project settings → **Your apps** → Add app
      → iOS. Bundle ID: `com.aroleap.commoncomm`. Download
      `GoogleService-Info.plist`. (Keep it — EAS will ask for it on first
      iOS build.)
- [ ] Add another app → Android. Package name: `com.aroleap.commoncomm`.
      Download `google-services.json`.
- [ ] Authentication → **Sign-in method** → Google → ensure it's enabled.
      Note the iOS, Android, and Web OAuth client IDs (under Web SDK
      configuration). You'll paste them in Phase D.
- [ ] Project settings → **Cloud Messaging** → confirm Firebase Cloud
      Messaging API (V1) is enabled. For iOS only: upload the APNs auth
      key (.p8) you'll generate in Phase C.

## Phase C — Apple developer portal (~5 min, needs Apple Dev account)

- [ ] developer.apple.com → Certificates, Identifiers & Profiles → Keys →
      "+" → check **Apple Push Notifications service (APNs)** → Continue
      → Download the `.p8` file (one-time download — save it). Note the
      Key ID and your Team ID.
- [ ] Upload the `.p8` to Firebase (Cloud Messaging settings) for iOS push.

## Phase D — Local setup (~10 min)

- [ ] `cd CommonCommunication`
- [ ] `git fetch && git checkout claude/mobile-app-planning-xYA2j`
- [ ] `cd mobile-app && npm install`
- [ ] Copy `.env.example` → `.env`, fill in:
  - `GOOGLE_IOS_CLIENT_ID`
  - `GOOGLE_ANDROID_CLIENT_ID`
  - `GOOGLE_WEB_CLIENT_ID`
- [ ] `npx eas login` (logs into your Expo account)
- [ ] `npx eas init --id <create-or-existing>` — writes the EAS project
      ID. Put it in `.env` as `EAS_PROJECT_ID`.

## Phase E — Worker (~2 min, needs Cloudflare access)

The Worker on `main` doesn't have the push fan-out yet. Deploy from the
feature branch (or merge to main first if you've already reviewed):

- [ ] `cd ..` (back to repo root)
- [ ] `wrangler deploy` (no new secrets required for push fan-out itself)
- [ ] (Optional) `wrangler secret put EXPO_ACCESS_TOKEN` to raise push
      rate limits beyond the free tier. Get a token at
      https://expo.dev/accounts/<you>/settings/access-tokens.

## Phase F — Try it (~5 min)

- [ ] Install **Expo Go** on your Android phone (Play Store).
- [ ] `cd mobile-app && npx expo start` on your laptop. Make sure the phone
      and laptop are on the same Wi-Fi.
- [ ] Scan the QR with Expo Go.
- [ ] Sign in with `rohit@aroleap.com` (or any allowlisted Google account).
- [ ] Try: open a chat, send a text, long-press a message → Create ticket,
      check ✨ summary, attach a photo.
- [ ] Open the chat on someone else's device to verify push notifications
      fire.

## Phase G — Real install (~30 min, blocks on first iOS build)

- [ ] `eas build --profile preview --platform android` → produces an APK.
      Send the install link to teammates' Android phones.
- [ ] `eas build --profile preview --platform ios` → produces an .ipa.
      EAS will walk you through signing on first run (it can manage Apple
      certs/profiles for you).
- [ ] `eas submit --platform ios` → uploads to App Store Connect.
- [ ] In App Store Connect → TestFlight → Internal testing → add team
      emails. They get an email and install via the TestFlight app.

## Troubleshooting

- **`expo start` fails with "missing client ID"** — `.env` isn't being
  read. Make sure you're running it from `mobile-app/` and the file is
  named exactly `.env`.
- **Google sign-in throws "redirect_uri_mismatch"** — Firebase Console →
  Authentication → Settings → Authorized domains needs `auth.expo.io` for
  Expo Go testing.
- **Push tokens never get registered** — check Firebase RTDB
  `commonComm/pushTokens/{your-uid}/` after sign-in. If empty,
  `Constants.expoConfig.extra.eas.projectId` is probably unset.
- **Typecheck fails on `npm run tsc`** — you may need to run
  `npm install` again after pulling new code.
