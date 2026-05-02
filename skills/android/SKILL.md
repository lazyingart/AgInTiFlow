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
3. If a Gradle wrapper is needed, create `gradle/wrapper/` before downloading files. Prefer a valid project-local wrapper or an already-installed Gradle. Do not loop on the same failed install/download.
4. Patch source-set-aware files only: manifests, Gradle scripts, Kotlin/Java sources, XML resources, and project docs. Keep generated build outputs out of patches and commits.
5. Build with the narrowest useful task first, usually `./gradlew :app:assembleDebug` or `./gradlew assembleDebug`. Repair build failures from the actual error text.
6. Install and launch on an available device/emulator with `adb install` and `adb shell am start`. Verify with `adb shell pidof`, `adb logcat -d`, `adb shell screencap`, or similar evidence when available.
7. Commit only after build/install/launch verification, with a clear message. Before final summary, run `git status --short`; leave source changes committed and generated/session artifacts ignored or explicitly reported. If no device/emulator exists, finish with a concrete external blocker and the generated APK path.

## Missing Tooling

If SDK/emulator tooling is missing, produce a setup report or project-local script rather than guessing. On host mode, never ask for or send a sudo password.
