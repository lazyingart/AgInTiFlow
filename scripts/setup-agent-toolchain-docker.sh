#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
IMAGE="${AGINTIFLOW_TOOLCHAIN_IMAGE:-agintiflow-sandbox:latest}"
WORKSPACE="${AGINTIFLOW_TOOLCHAIN_WORKSPACE:-${REPO_ROOT}}"
DOCKERFILE="${AGINTIFLOW_TOOLCHAIN_DOCKERFILE:-${REPO_ROOT}/docker/sandbox.Dockerfile}"
STATE_DIR="${AGINTIFLOW_DOCKER_STATE_DIR:-${HOME:-/tmp}/.agintiflow/docker}"
FORCE_REBUILD="${AGINTIFLOW_FORCE_TOOLCHAIN_REBUILD:-false}"

os_name="$(uname -s 2>/dev/null || printf unknown)"
case "${os_name}" in
  Darwin) platform_hint="macOS: use Docker Desktop or Colima; host LaTeX can come from MacTeX/BasicTeX." ;;
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      platform_hint="WSL: use Docker Desktop WSL integration or Docker Engine inside WSL."
    elif [ -r /etc/os-release ] && grep -Eqi '^(ID|ID_LIKE)=.*(rhel|fedora|centos|rocky|almalinux|redhat)' /etc/os-release; then
      platform_hint="Red Hat/Fedora family: install Docker with dnf/yum or vendor docs; do not use install-docker-ubuntu.sh."
    else
      platform_hint="Linux: Ubuntu/Debian hosts may use scripts/install-docker-ubuntu.sh."
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*) platform_hint="Windows shell: prefer WSL2 for AgInTiFlow Docker/toolchain workflows." ;;
  *) platform_hint="Use a Docker-capable environment with Node.js 22+." ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH." >&2
  echo "${platform_hint}" >&2
  exit 1
fi

mkdir -p "${WORKSPACE}"
mkdir -p "${STATE_DIR}/home" "${STATE_DIR}/cache" "${STATE_DIR}/env"

host_latex="missing"
if command -v latexmk >/dev/null 2>&1 && command -v pdflatex >/dev/null 2>&1; then
  host_latex="complete"
elif command -v latexmk >/dev/null 2>&1 || command -v pdflatex >/dev/null 2>&1; then
  host_latex="partial"
fi

run_preflight() {
  docker run --rm \
    --network none \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 256 \
    --memory 2g \
    --cpus 2 \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    -e HOME=/aginti-home \
    -e XDG_CACHE_HOME=/aginti-cache \
    -e PIP_CACHE_DIR=/aginti-cache/pip \
    -e MPLCONFIGDIR=/tmp/matplotlib \
    -e NPM_CONFIG_CACHE=/aginti-cache/npm \
    -e CONDA_PKGS_DIRS=/aginti-cache/conda-pkgs \
    -v "${WORKSPACE}:/workspace:rw" \
    -v "${STATE_DIR}/home:/aginti-home:rw" \
    -v "${STATE_DIR}/cache:/aginti-cache:rw" \
    -v "${STATE_DIR}/env:/aginti-env:rw" \
    -w /workspace \
    "${IMAGE}" \
    bash -lc 'set -Eeuo pipefail
      mkdir -p /tmp/matplotlib
      if [ ! -x /aginti-env/python/bin/python ]; then python3 -m venv --system-site-packages /aginti-env/python; fi
      . /aginti-env/python/bin/activate
      node -v
      npm -v
      python3 --version
      python3 - <<PY
import matplotlib, numpy
print("matplotlib", matplotlib.__version__)
print("numpy", numpy.__version__)
PY
      latexmk -version | head -1
      pdflatex --version | head -1
    '
}

echo "AgInTiFlow toolchain sandbox:"
echo "  image=${IMAGE}"
echo "  dockerfile=${DOCKERFILE}"
echo "  context=${REPO_ROOT}"
echo "  persistent=${STATE_DIR}"
echo "  platform=${os_name}"
echo "  hostLatex=${host_latex}"
echo "  note=${platform_hint}"

if [ "${FORCE_REBUILD}" != "true" ] && docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo
  echo "Existing image found. Running preflight before rebuilding:"
  if run_preflight; then
    echo
    echo "Toolchain sandbox is already ready; skipped Docker rebuild and TeX Live redownload."
    exit 0
  fi
  echo
  echo "Existing image failed preflight; rebuilding ${IMAGE}."
fi

echo
echo "Building AgInTiFlow toolchain sandbox image:"
docker build -t "${IMAGE}" -f "${DOCKERFILE}" "${REPO_ROOT}"

echo
echo "Running toolchain preflight inside Docker:"
run_preflight

echo
echo "Toolchain sandbox is ready."
