---
id: rust
label: Rust Development
description: Build, test, debug, and maintain Rust crates, Cargo workspaces, CLIs, services, and libraries.
triggers:
  - rust
  - cargo
  - crate
  - borrow checker
  - clippy
tools:
  - inspect_project
  - search_files
  - read_file
  - apply_patch
  - run_command
---
# Rust Development

Inspect `Cargo.toml`, workspace members, features, modules, examples, and tests before editing.

Prefer narrow `cargo check -p`, `cargo test -p`, or targeted test commands before broad workspace checks. Run `cargo fmt` when available, avoid unnecessary dependency churn, and explain safety/unsafe or lifetime tradeoffs clearly.

