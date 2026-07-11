# Android Release

Use this path to produce the signed Android App Bundle that Google Play expects.
The app ID is `com.berkayturanci.voicebridge` and the Android target SDK is 35.

## One-Time Signing Setup

Generate and store an upload key outside the repository:

```bash
keytool -genkey -v \
  -keystore voicebridge-upload-keystore.jks \
  -storetype JKS \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias voicebridge-upload
```

Add these GitHub Actions repository secrets:

- `ANDROID_UPLOAD_KEYSTORE_BASE64`: base64-encoded contents of the upload
  keystore.
- `ANDROID_KEY_ALIAS`: the key alias, for example `voicebridge-upload`.
- `ANDROID_KEY_PASSWORD`: the key password.
- `ANDROID_STORE_PASSWORD`: the keystore password.

Encode the keystore with:

```bash
base64 -i voicebridge-upload-keystore.jks | pbcopy
```

Never commit `android/key.properties`, `.jks`, or `.keystore` files. The Android
project ignores these files.

## CI Release Build

Run the `Android Release` workflow manually from GitHub Actions. Optional inputs:

- `version_name`: overrides the Flutter build name, for example `0.6.1`.
- `version_code`: overrides the Android build number. This must increase for
  every Play Console upload.

The workflow writes `app/android/key.properties` from secrets, builds a signed
release AAB, and uploads `app-release.aab` as a short-lived workflow artifact.

## Local Signed Build

For a local release build, copy the upload keystore into `app/android/` and
create `app/android/key.properties`:

```properties
storeFile=upload-keystore.jks
storePassword=...
keyAlias=voicebridge-upload
keyPassword=...
```

Then build:

```bash
cd app
flutter pub get
flutter build appbundle --release --build-name 0.6.1 --build-number 601
```

Without `key.properties`, local and pull request release builds intentionally use
the debug signing config so CI can verify packaging without repository secrets.
