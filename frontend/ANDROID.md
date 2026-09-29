# Android app

The Android app is this same React frontend wrapped with Capacitor 7. It talks to the
hosted API (Vercel), so it needs an internet connection, like the website.

## Build an APK

Requirements: Node 20+, JDK 21, Android SDK (platform 35). Paths are set in
`android/local.properties` (git-ignored).

1. Put the deployed site's address in `frontend/.env.android`:
   `VITE_API_URL=https://your-app.vercel.app`
2. From `frontend/`:
   ```
   npm run android:apk
   ```
3. The signed APK is at `android/app/build/outputs/apk/release/app-release.apk`.
   Copy it to the phone and open it (allow "install unknown apps" once).

Bump `versionCode` (and `versionName`) in `android/app/build.gradle` for each release you
hand out, so phones accept it as an update.

## Signing key: back it up

Release builds are signed with `android/keystore/cogs-release.jks`, whose passwords are in
`android/keystore.properties`. Both are git-ignored. **Keep a copy somewhere safe** (e.g. a
private cloud drive). Android only installs an update over an existing app if it is signed
with the same key; if the key is lost, every phone has to uninstall and reinstall.

## Icons and splash

Sources are in `frontend/assets/`. After changing them:
```
npx @capacitor/assets@3.0.5 generate --android --iconBackgroundColor "#6366f1" --splashBackgroundColor "#eef0fb" --splashBackgroundColorDark "#eef0fb"
```
