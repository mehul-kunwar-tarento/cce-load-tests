#!/usr/bin/env bash
# build-k6-image.sh — builds the k6 Docker image every k6 performance test runs in
#
# What:    docker build of docker/k6/Dockerfile: k6 2.3.0 with the xk6-kafka 2.2.0 extension (Kafka support for
#          the matcher tests). See docker/k6/README.md for why the image is custom-built.
# How:     scripts/build-k6-image.sh            (from anywhere; build once per machine)
# Needs:   Docker, and internet access during the build (base images, Go modules).
# Outputs: The local image cce-load-tests/k6:2.3.0-kafka2.2.0; check it with
#          docker run --rm cce-load-tests/k6:2.3.0-kafka2.2.0 version
set -euo pipefail

# Same tag as k6.image in config/environments/*.json; change both together.
IMAGE="cce-load-tests/k6:2.3.0-kafka2.2.0"
# The repository root, so the script works from any folder.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Building ${IMAGE} from ${ROOT}/docker/k6 ..."
docker build -t "${IMAGE}" "${ROOT}/docker/k6"
docker run --rm "${IMAGE}" version
