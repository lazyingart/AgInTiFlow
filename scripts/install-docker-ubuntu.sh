#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ! -r /etc/os-release ]]; then
  echo "This script requires /etc/os-release." >&2
  exit 1
fi

. /etc/os-release

if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "This script targets Ubuntu hosts. Detected ID=${ID:-unknown}." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get is required on this host." >&2
  exit 1
fi

if ! command -v dpkg >/dev/null 2>&1; then
  echo "dpkg is required on this host." >&2
  exit 1
fi

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this script as root or install sudo first." >&2
    exit 1
  fi
  SUDO=(sudo)
fi

TARGET_USER="${DOCKER_TARGET_USER:-${SUDO_USER:-}}"
ARCHITECTURE="$(dpkg --print-architecture)"
CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"

if [[ -z "${CODENAME}" ]]; then
  echo "Unable to determine the Ubuntu codename." >&2
  exit 1
fi

CONFLICTING_PACKAGES=(
  docker.io
  docker-compose
  docker-compose-v2
  docker-doc
  podman-docker
  containerd
  runc
)

DOCKER_PACKAGES=(
  docker-ce
  docker-ce-cli
  containerd.io
  docker-buildx-plugin
  docker-compose-plugin
)

run() {
  echo "+ $*"
  "$@"
}

echo "Installing Docker Engine for Ubuntu ${VERSION_ID:-unknown} (${CODENAME}) on ${ARCHITECTURE}."

mapfile -t INSTALLED_CONFLICTS < <(dpkg-query -W -f='${binary:Package}\n' "${CONFLICTING_PACKAGES[@]}" 2>/dev/null || true)
if [[ "${#INSTALLED_CONFLICTS[@]}" -gt 0 ]]; then
  run "${SUDO[@]}" apt-get remove -y "${INSTALLED_CONFLICTS[@]}"
fi

run "${SUDO[@]}" apt-get update
run "${SUDO[@]}" apt-get install -y ca-certificates curl
run "${SUDO[@]}" install -m 0755 -d /etc/apt/keyrings
run "${SUDO[@]}" curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
run "${SUDO[@]}" chmod a+r /etc/apt/keyrings/docker.asc

DOCKER_SOURCE_FILE="/etc/apt/sources.list.d/docker.sources"
DOCKER_SOURCE_CONTENT="$(cat <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${CODENAME}
Components: stable
Architectures: ${ARCHITECTURE}
Signed-By: /etc/apt/keyrings/docker.asc
EOF
)"

echo "+ writing ${DOCKER_SOURCE_FILE}"
printf '%s\n' "${DOCKER_SOURCE_CONTENT}" | "${SUDO[@]}" tee "${DOCKER_SOURCE_FILE}" >/dev/null

run "${SUDO[@]}" apt-get update
run "${SUDO[@]}" apt-get install -y "${DOCKER_PACKAGES[@]}"

if command -v systemctl >/dev/null 2>&1; then
  run "${SUDO[@]}" systemctl enable --now containerd
  run "${SUDO[@]}" systemctl enable --now docker
fi

if [[ -n "${TARGET_USER}" && "${TARGET_USER}" != "root" ]]; then
  if ! getent group docker >/dev/null 2>&1; then
    run "${SUDO[@]}" groupadd docker
  fi
  run "${SUDO[@]}" usermod -aG docker "${TARGET_USER}"
fi

run "${SUDO[@]}" docker version

if [[ "${RUN_HELLO_WORLD:-1}" == "1" ]]; then
  run "${SUDO[@]}" docker run --rm hello-world
fi

echo
echo "Docker installation is complete."
echo "CLI checks:"
echo "  docker --version"
echo "  docker compose version"
echo
if [[ -n "${TARGET_USER}" && "${TARGET_USER}" != "root" ]]; then
  echo "The user '${TARGET_USER}' was added to the docker group."
  echo "Open a new login shell, sign out and back in, or run:"
  echo "  newgrp docker"
  echo
  echo "After group refresh, verify non-root access with:"
  echo "  docker run --rm hello-world"
else
  echo "No non-root target user was configured."
  echo "If you ran this as root and want a regular user to access Docker, rerun with:"
  echo "  DOCKER_TARGET_USER=<your-username> ./scripts/install-docker-ubuntu.sh"
fi
