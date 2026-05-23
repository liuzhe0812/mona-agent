#!/usr/bin/env bash
set -euo pipefail

PYTHON_VERSION="3.12.9"
PYTHON_TAG="cpython-${PYTHON_VERSION}+20250416"
BASE_URL="https://github.com/indygreg/python-build-standalone/releases/download/20250416"

RESOURCES_DIR="$(dirname "$0")/resources"
mkdir -p "${RESOURCES_DIR}"

detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    if [[ "${os}" == "Darwin" ]]; then
        if [[ "${arch}" == "arm64" ]]; then
            echo "aarch64-apple-darwin"
        else
            echo "x86_64-apple-darwin"
        fi
    elif [[ "${os}" == "Linux" ]]; then
        if [[ "${arch}" == "aarch64" ]]; then
            echo "aarch64-unknown-linux-gnu"
        else
            echo "x86_64-unknown-linux-gnu"
        fi
    fi
}

PLATFORM="$(detect_platform)"
FILENAME="${PYTHON_TAG}-${PLATFORM}-install_only.tar.gz"
URL="${BASE_URL}/${FILENAME}"
DEST_PATH="${RESOURCES_DIR}/python.tar.gz"

if [[ -f "${DEST_PATH}" ]]; then
    echo "Python archive already exists at ${DEST_PATH}"
    echo "Delete it and re-run to download again."
    exit 0
fi

echo "Downloading python-build-standalone ${PYTHON_VERSION} for ${PLATFORM}..."
echo "URL: ${URL}"

curl -fSL -o "${DEST_PATH}" "${URL}"

FILESIZE=$(du -h "${DEST_PATH}" | cut -f1)
echo "Download complete. Size: ${FILESIZE}"
echo "Saved to: ${DEST_PATH}"
