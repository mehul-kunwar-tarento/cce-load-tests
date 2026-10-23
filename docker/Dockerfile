# k6 with Kafka support (xk6-kafka), used by run.sh for every test.
# The official grafana/k6 image has no Kafka support, so we build our own k6 binary with xk6.
#
# Build: docker build -t cce-load-tests/k6:2.3.0-kafka2.2.0 docker/   (run.sh does this when the image is missing)

# Step 1: build the k6 binary with the Kafka extension.
# - xk6-kafka v2.x is the line built for k6 v2 (v1.x only works with k6 v1).
# - --cgo: xk6-kafka v2 uses Confluent's Kafka client, which is C code underneath.
FROM grafana/xk6:1.4.15 AS build
RUN xk6 build v2.3.0 --cgo \
      --with github.com/mostafa/xk6-kafka/v2@v2.2.0 \
      --output /tmp/k6

# Step 2: a small image to run it. With cgo the binary needs glibc, which the Alpine-based grafana/k6
# image lacks, so use Wolfi (the same Linux family as the build image above).
FROM cgr.dev/chainguard/wolfi-base
COPY --from=build /tmp/k6 /usr/bin/k6
ENTRYPOINT ["k6"]
