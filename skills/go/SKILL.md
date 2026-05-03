---
id: go
label: Go Development
description: Build, test, debug, and maintain Go modules, CLIs, servers, packages, and tooling.
triggers:
  - go
  - golang
  - go.mod
  - go test
  - gofmt
tools:
  - inspect_project
  - search_files
  - read_file
  - apply_patch
  - run_command
---
# Go Development

Inspect `go.mod`, commands under `cmd/`, packages under `internal/` or `pkg/`, and tests before editing.

Use `gofmt` on changed Go files and run focused `go test` commands, broadening to `go test ./...` when practical. Keep module/download noise out of commits and report missing Go/private module blockers precisely.

