<!--
  What:    Explains the k6 Docker image used by every k6 performance test: why it is custom-built, how to
           build it and how to check it.
  How:     Read before the first run on a new machine; build with scripts/build-k6-image.sh.
  Needs:   Docker. Background: docker/k6/Dockerfile (same folder).
  Outputs: Documentation only.
-->

# k6 Docker image `cce-load-tests/k6:2.3.0-kafka2.2.0`

Every k6 test runs inside this image (decision D4: k6 only, open load model). It is **k6 2.3.0** with the
**xk6-kafka 2.2.0** extension built in.

## Why a custom image

| Need | Answer |
|---|---|
| The matcher test writes events straight into Kafka (`lib/kafka-client.js`) | The official `grafana/k6` image has no Kafka support, so `xk6` (k6's extension builder) compiles k6 with `github.com/mostafa/xk6-kafka/v2` |
| xk6-kafka v2 is built on Confluent's Kafka client (librdkafka, C code) | The build uses `--cgo` |
| A cgo binary needs glibc | The Alpine-based `grafana/k6` image lacks glibc, so the runtime image is **Wolfi** (`cgr.dev/chainguard/wolfi-base`, the same Linux family as the `grafana/xk6` build image) |
| xk6-kafka v2.x matches k6 v2 | v1.x of the extension only works with k6 v1 |

Built into k6 itself (no extension needed):

- **Prometheus remote write**: `-o experimental-prometheus-rw` sends k6 metrics to Prometheus (and so to Grafana),
  tagged `testid`, `service`, `test_type`, `plan_definition_set`, `environment` (plan §9.3). Configured with
  `K6_PROMETHEUS_RW_*` environment variables by the runner.
- **REST API**: `--address <host>:<port>` exposes k6's status as JSON while it runs. The runner
  (`tools/core/k6-clock.mjs`) polls `GET /v1/status` to learn the moment the scenarios start (plan §4.7, §6.3).

## Build

```bash
scripts/build-k6-image.sh
# same as: docker build -t cce-load-tests/k6:2.3.0-kafka2.2.0 docker/k6
```

The build needs internet access (base images and Go modules) and takes a few minutes. The runner does not
build the image itself; build it once per machine.

## Check

```bash
docker run --rm cce-load-tests/k6:2.3.0-kafka2.2.0 version
# k6 v2.3.0 (go1.27.1, linux/amd64)
# Extensions:
#   github.com/mostafa/xk6-kafka/v2 v2.2.0, k6/x/kafka [js]
```

Check a test script without running it (no network needed; tests read their settings from a run context):

```bash
docker run --rm --network none -v "$PWD":/tests -w /tests cce-load-tests/k6:2.3.0-kafka2.2.0 \
  inspect -e RUN_CONTEXT=/tests/results/<run>/run-context.json <service-folder>/tests/<test>.test.js
```

`npm run check:k6` does this for every `*.test.js` (A2, plan §6.10).

## Changing versions

Change the tag in **three** places together: the `xk6 build` line of the `Dockerfile`, the image name in
`scripts/build-k6-image.sh`, and `k6.image` in `config/environments/*.json`. Keep k6 and xk6-kafka on matching
major versions, then re-run `k6 inspect` on every test and the lib unit tests.
