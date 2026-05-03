---
id: java-jvm
label: Java JVM Development
description: Build, test, debug, and maintain Java, Kotlin JVM, Maven, Gradle, Spring, and JUnit projects.
triggers:
  - java
  - jvm
  - kotlin
  - maven
  - gradle
  - spring
  - junit
tools:
  - inspect_project
  - search_files
  - read_file
  - apply_patch
  - run_command
---
# Java JVM Development

Inspect the build system before editing: `pom.xml`, `build.gradle`, `settings.gradle`, wrapper files, modules, source sets, and tests.

Prefer project-local `./mvnw`, `./gradlew`, or existing Maven/Gradle commands. Run focused compile/test tasks first, keep generated `target/`, `build/`, and `.gradle/` artifacts out of commits, and stop on missing JDK or credential blockers with exact evidence.

