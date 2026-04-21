#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ROOT="${SCRIPT_DIR}"
RAW_ROOT="${TARGET_ROOT}/raw"

repos=(
  "/home/lachlan/ProjectsLFS/Agent/claude-code"
  "/home/lachlan/ProjectsLFS/Agent/codex"
  "/home/lachlan/ProjectsLFS/Agent/copilot"
  "/home/lachlan/ProjectsLFS/Agent/gemini-cli"
  "/home/lachlan/ProjectsLFS/Agent/LazyingArtBot"
  "/home/lachlan/ProjectsLFS/Agent/qwen-code"
  "/home/lachlan/ProjectsLFS/Agent/claw-code"
)

mkdir -p "${RAW_ROOT}"

for repo in "${repos[@]}"; do
  name="$(basename "${repo}")"
  out="${RAW_ROOT}/${name}"
  mkdir -p "${out}"

  {
    echo "# ${name}"
    echo
    echo "path=${repo}"
    echo "timestamp=$(date -Iseconds)"
    echo
    echo "## Top Level"
    ls -la "${repo}"
    echo
    echo "## Selected Files"
    find "${repo}" -maxdepth 3 -type f \
      \( -name 'README.md' -o -name 'AGENTS.md' -o -name 'CLAUDE.md' -o -name 'PHILOSOPHY.md' -o -name 'USAGE.md' -o -name 'PARITY.md' -o -name 'ROADMAP.md' -o -name 'package.json' -o -name 'Cargo.toml' -o -name 'pyproject.toml' -o -name 'go.mod' \) \
      | sort
  } > "${out}/overview.txt"

  if [[ -f "${repo}/README.md" ]]; then
    sed -n '1,260p' "${repo}/README.md" > "${out}/README.md.head.txt"
  fi

  if [[ -f "${repo}/AGENTS.md" ]]; then
    sed -n '1,260p' "${repo}/AGENTS.md" > "${out}/AGENTS.md.head.txt"
  fi

  if [[ -f "${repo}/CLAUDE.md" ]]; then
    sed -n '1,260p' "${repo}/CLAUDE.md" > "${out}/CLAUDE.md.head.txt"
  fi

  if [[ -f "${repo}/PHILOSOPHY.md" ]]; then
    sed -n '1,260p' "${repo}/PHILOSOPHY.md" > "${out}/PHILOSOPHY.md.head.txt"
  fi

  if [[ -f "${repo}/USAGE.md" ]]; then
    sed -n '1,260p' "${repo}/USAGE.md" > "${out}/USAGE.md.head.txt"
  fi

  if [[ -f "${repo}/PARITY.md" ]]; then
    sed -n '1,260p' "${repo}/PARITY.md" > "${out}/PARITY.md.head.txt"
  fi

  if [[ -f "${repo}/ROADMAP.md" ]]; then
    sed -n '1,260p' "${repo}/ROADMAP.md" > "${out}/ROADMAP.md.head.txt"
  fi

  if [[ -f "${repo}/rust/README.md" ]]; then
    sed -n '1,260p' "${repo}/rust/README.md" > "${out}/rust.README.md.head.txt"
  fi

  if [[ -f "${repo}/package.json" ]]; then
    sed -n '1,260p' "${repo}/package.json" > "${out}/package.json.head.txt"
  fi

  if [[ -f "${repo}/Cargo.toml" ]]; then
    sed -n '1,260p' "${repo}/Cargo.toml" > "${out}/Cargo.toml.head.txt"
  fi

  if [[ -f "${repo}/pyproject.toml" ]]; then
    sed -n '1,260p' "${repo}/pyproject.toml" > "${out}/pyproject.toml.head.txt"
  fi

  if [[ -f "${repo}/go.mod" ]]; then
    sed -n '1,260p' "${repo}/go.mod" > "${out}/go.mod.head.txt"
  fi

  rg -n --glob 'README.md' --glob 'AGENTS.md' --glob 'CLAUDE.md' --glob 'PHILOSOPHY.md' --glob 'USAGE.md' --glob 'PARITY.md' --glob 'ROADMAP.md' \
    'sandbox|container|tool|agent|workflow|memory|session|resume|provider|plugin|extension|subagent|design|architecture|philosophy|coordination|parity|permission|human|review|verification' \
    "${repo}" > "${out}/concept_hits.txt" || true
done
