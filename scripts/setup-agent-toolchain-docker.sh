#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
IMAGE="${AGINTIFLOW_TOOLCHAIN_IMAGE:-agintiflow-sandbox:latest}"
WORKSPACE="${AGINTIFLOW_TOOLCHAIN_WORKSPACE:-${REPO_ROOT}}"
DOCKERFILE="${AGINTIFLOW_TOOLCHAIN_DOCKERFILE:-${REPO_ROOT}/docker/sandbox.Dockerfile}"
STATE_DIR="${AGINTIFLOW_DOCKER_STATE_DIR:-${HOME:-/tmp}/.agintiflow/docker}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH. Run scripts/install-docker-ubuntu.sh first." >&2
  exit 1
fi

mkdir -p "${WORKSPACE}"
mkdir -p "${STATE_DIR}/home" "${STATE_DIR}/cache" "${STATE_DIR}/env"

echo "Building AgInTiFlow toolchain sandbox image:"
echo "  image=${IMAGE}"
echo "  dockerfile=${DOCKERFILE}"
echo "  context=${REPO_ROOT}"
echo "  persistent=${STATE_DIR}"
docker build -t "${IMAGE}" -f "${DOCKERFILE}" "${REPO_ROOT}"

echo
echo "Running toolchain preflight inside Docker:"
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
  -e NPM_CONFIG_CACHE=/aginti-cache/npm \
  -e CONDA_PKGS_DIRS=/aginti-cache/conda-pkgs \
  -v "${WORKSPACE}:/workspace:rw" \
  -v "${STATE_DIR}/home:/aginti-home:rw" \
  -v "${STATE_DIR}/cache:/aginti-cache:rw" \
  -v "${STATE_DIR}/env:/aginti-env:rw" \
  -w /workspace \
  "${IMAGE}" \
  bash -lc 'set -Eeuo pipefail
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

echo
echo "Toolchain sandbox is ready."
