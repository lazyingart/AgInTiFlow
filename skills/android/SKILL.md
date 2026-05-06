---
id: android
label: Android Development
description: Build and debug Android, Gradle, Kotlin, Java, emulator, and mobile app projects.
triggers:
  - android
  - gradle
  - kotlin
  - java
  - apk
  - emulator
tools:
  - inspect_project
  - search_files
  - apply_patch
  - run_command
  - web_search
---
# Android Development

## Operating Loop

1. Inspect before editing: `git status --short`, project tree, Gradle/settings files, AndroidManifest, package names, modules, Java/Kotlin versions, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, likely SDK folders, `adb devices`, and emulator/AVD availability.
2. Do not use host `sudo`, `apt`, `dnf`, `yum`, `brew`, `winget`, or global host installs for Android app work. These can hang on password prompts or mutate the user's machine. Prefer existing Android SDK tools, project-local Gradle wrapper setup, user-writable caches, or a clear setup report with the exact manual command.
3. Android SDK and emulator tooling usually lives on the host, not inside Docker. If a permission block appears while using a host SDK/emulator, prefer the exact trusted host resume command from `permissionAdvice.trustedHostCommand` over a Docker rerun unless the SDK is explicitly mounted in Docker.
4. If a Gradle wrapper is needed, create `gradle/wrapper/` before downloading files. Prefer a valid project-local wrapper or an already-installed Gradle. Do not loop on the same failed install/download.
5. Patch source-set-aware files only: manifests, Gradle scripts, Kotlin/Java sources, XML resources, and project docs. Keep generated build outputs out of patches and commits.
6. Build with the narrowest useful task first, usually `./gradlew :app:assembleDebug` or `./gradlew assembleDebug`. If host Android/JDK paths must be explicit, use safe local env assignments around that exact command, for example `ANDROID_HOME=/home/user/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew assembleDebug`; prefer relative workspace log paths if recording exit status. Repair build failures from the actual error text.
7. Install and launch on an available device/emulator with `adb install` and `adb shell am start`. Verify with `adb shell pidof`, `adb logcat -d`, `adb shell screencap`, or similar evidence when available.
8. Save screenshots and APK references in durable workspace paths with descriptive names when the user did not specify paths, for example `artifacts/screenshots/<app>-<timestamp>.png` and `app/build/outputs/apk/debug/app-debug.apk`. Do not rely only on a temporary screenshot that is deleted after canvas preview.
9. Commit only after build/install/launch verification, with a clear message. Before final summary, run `git status --short`; leave source changes committed and generated/session artifacts ignored or explicitly reported. If no device/emulator exists, finish with a concrete external blocker and the generated APK path.

## Missing Tooling

If SDK/emulator tooling is missing, produce a setup report or project-local script rather than guessing. On host mode, never ask for or send a sudo password.
