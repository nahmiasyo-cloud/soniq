# SONIQ – store builds

The site files at the repo root are copied into `app/www` and wrapped with Capacitor.
Builds run in GitHub Actions on every push to the `app` branch (`.github/workflows/app-build.yml`).
Results are uploaded to the GitHub Releases `android-build` and `ios-build`.

## Secrets (repo Settings → Secrets and variables → Actions)
- `ANDROID_KEY_PASS` – password for `app/upload.jks.enc` (upload keystore, alias `upload`). Keep a private copy; without it, signed Android builds stop.
- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` – App Store Connect API key (Admin or App Manager).
- `APPLE_TEAM_ID` – 10-character Team ID from developer.apple.com → Membership.

Without secrets the workflow still builds a debug APK (Android) and a simulator build (iOS) to check that everything compiles.
