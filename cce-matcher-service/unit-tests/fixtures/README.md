<!--
  What:    Fixtures of the matcher unit tests (verbatim test data; JSON cannot carry a header comment, so it
           is documented here).
  How:     Read by cce-matcher-service/unit-tests/data-checks.spec.mjs only. Never edited by a test.
  Needs:   Nothing.
  Outputs: Nothing.
-->

# Matcher unit-test fixtures

| File | Origin | Content |
|---|---|---|
| `k6-summary-matcher-load.json` | **Synthetic**, written once by hand in the shape of `lib/README.md` ("`k6-summary.json` shape") and of the captured xk6-kafka metric names in `lib/unit-tests/fixtures/k6-summary-kafka.json` | A matcher load run at the defaults: warm-up 60 s at 10/s (600 events) + measure 600 s at 50/s (30,000 events) = **30,600** events. `kafka_writer_message_count`, `events_sent` and `events_accepted` all 30,600; no Kafka write errors; 0 dropped; checks 100 %; `context` with run id `20261105-142233`, subject `matcher`, test type `load` |

Why a fixture of our own: the folder must stay self-contained (it is copied later into the
cce-matcher-service repository), so its tests never read `lib/unit-tests/fixtures/`.
Every other fake (clock, Kafka admin, metrics page, Postgres) is built in code by `../fakes.mjs`.
