#!/usr/bin/env bash
# Samples the resource use of the eBUZIMA flow (adaptor → collector → matcher → Step SLA) every few
# seconds until stopped, then (with --summary) prints min/avg/max per metric. Start it before a load
# test, stop it after. flow.sh does both.
#   JVM (all four services, from /actuator/prometheus): heap, GC pauses, threads, CPU, executors
#   Collector, matcher, Step SLA: Hikari database pool
#   Collector: Kafka producer. Matcher: events processed, consumer errors, slowest event.
#   Step SLA: transitions due (its backlog), applied, skipped, failed batches
#   Postgres: connections by state (pg_stat_activity)
#   Containers (docker stats): CPU, memory, network and disk I/O
#
# Run: ./monitor.sh <env> <out.tsv> [interval-seconds]     (Ctrl-C or kill to stop)
#      ./monitor.sh --summary <out.tsv>                    (summarise a finished sample file)
# Needs: docker, curl, jq. Containers are found by the ports in env/<env>.json, so it must run on
# the same server as the services.
set -euo pipefail
cd "$(dirname "$0")"

# ---------------------------------------------------------------------------------------------
# Summary: gauges as min/avg/max, counters as the increase over the run.
# ---------------------------------------------------------------------------------------------
if [[ "${1:-}" == "--summary" ]]; then
  awk -F'\t' '
    function human(m, v) {
      if (m ~ /_bytes$/) return sprintf("%.0f MiB", v / 1048576)
      if (m ~ /_ms$/)    return sprintf("%.1f ms", v)
      if (m ~ /_pct$/)   return sprintf("%.1f%%", v)
      return sprintf("%.2f", v)
    }
    { k = $2 "\t" $3; if (!(k in n)) { order[++keys] = k; first[k] = $4; mn[k] = $4; mx[k] = $4 }
      n[k]++; sum[k] += $4; last[k] = $4; if ($4 < mn[k]) mn[k] = $4; if ($4 > mx[k]) mx[k] = $4 }
    END {
      printf "| Source | Metric | Min | Avg | Max | Increase over run |\n|---|---|---|---|---|---|\n"
      for (i = 1; i <= keys; i++) { k = order[i]; split(k, p, "\t")
        if (p[2] ~ /_total/) printf "| %s | %s | | | | %s |\n", p[1], p[2], human(p[2], last[k] - first[k])
        else printf "| %s | %s | %s | %s | %s | |\n", p[1], p[2], human(p[2], mn[k]), human(p[2], sum[k] / n[k]), human(p[2], mx[k]) }
    }' "$2"
  exit 0
fi

ENV_NAME=${1:-}
OUT=${2:-}
INTERVAL=${3:-5}
CONFIG="env/${ENV_NAME}.json"
if [[ -z "$ENV_NAME" || ! -f "$CONFIG" || -z "$OUT" ]]; then
  echo "Usage: $0 <env> <out.tsv> [interval-seconds]   or   $0 --summary <out.tsv>" >&2
  exit 1
fi

ADAPTOR_URL=$(jq -r .openhimAdaptor.baseUrl "$CONFIG")
COLLECTOR_URL=$(jq -r .collector.baseUrl "$CONFIG")
MATCHER_URL=$(jq -r .matcher.metricsUrl "$CONFIG"); MATCHER_URL=${MATCHER_URL%/actuator/prometheus}
STEP_SLA_URL=$(jq -r .stepSla.metricsUrl "$CONFIG"); STEP_SLA_URL=${STEP_SLA_URL%/actuator/prometheus}
DB_NAME=$(jq -r .db.name "$CONFIG")
DB_USER=$(jq -r .db.user "$CONFIG")

container_for() { docker ps --filter "publish=${1##*:}" --format '{{.Names}}' | head -1; }
ADAPTOR_CTR=$(container_for "$ADAPTOR_URL")
COLLECTOR_CTR=$(container_for "$COLLECTOR_URL")
MATCHER_CTR=$(container_for "$MATCHER_URL")
STEP_SLA_CTR=$(container_for "$STEP_SLA_URL")
PG_CTR=$(container_for "$(jq -r .db.port "$CONFIG")")
KAFKA_CTR=$(container_for "$(jq -r '.matcher.kafkaBrokers[0]' "$CONFIG")")
echo "Sampling every ${INTERVAL}s into $OUT: $ADAPTOR_CTR $COLLECTOR_CTR $MATCHER_CTR $STEP_SLA_CTR $PG_CTR $KAFKA_CTR" >&2

# prom <file> <metric regex> <sum|max> [scale]: one value from a Prometheus text dump.
prom() {
  awk -v re="$2" -v op="$3" -v scale="${4:-1}" '
    $0 !~ /^#/ && $0 ~ ("^" re "([{ ]|$)") { v = $NF + 0; if (v < 0) next; seen = 1
      if (op == "max") { if (v > r) r = v } else r += v }
    END { if (seen) printf "%.6f\n", r * scale }' "$1"
}

# docker stats sizes ("1.2MB", "3.4GiB") to bytes.
to_bytes() {
  awk -v s="$1" 'BEGIN { n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
    f["B"] = 1; f["kB"] = 1e3; f["KiB"] = 1024; f["MB"] = 1e6; f["MiB"] = 1048576; f["GB"] = 1e9; f["GiB"] = 1073741824
    printf "%.0f\n", n * (u in f ? f[u] : 1) }'
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

while true; do
  ts=$(date +%H:%M:%S)
  {
    for svc in adaptor collector matcher step-sla; do
      case $svc in
        adaptor) url=$ADAPTOR_URL ;; collector) url=$COLLECTOR_URL ;;
        matcher) url=$MATCHER_URL ;; step-sla) url=$STEP_SLA_URL ;;
      esac
      curl -s -m 3 "$url/actuator/prometheus" > "$TMP/$svc.prom" || continue
      f=$TMP/$svc.prom
      row() { local v; v=$(prom "$f" "$2" "$3" "${4:-1}"); if [[ -n "$v" ]]; then printf '%s\t%s\t%s\t%s\n' "$ts" "$svc" "$1" "$v"; fi; }
      row heap_used_bytes        'jvm_memory_used_bytes[{][^}]*area="heap"[^}]*}' sum
      row heap_max_bytes         'jvm_memory_max_bytes[{][^}]*area="heap"[^}]*}' sum
      row heap_after_gc_pct      'jvm_memory_usage_after_gc' max 100
      row gc_pauses_total        'jvm_gc_pause_seconds_count' sum
      row gc_pause_time_total_ms 'jvm_gc_pause_seconds_sum' sum 1000
      row gc_pause_max_ms        'jvm_gc_pause_seconds_max' max 1000
      row gc_overhead_pct        'jvm_gc_overhead' max 100
      row threads_live           'jvm_threads_live_threads' sum
      row process_cpu_pct        'process_cpu_usage' max 100
      row executor_active        'executor_active_threads' sum
      row executor_queued        'executor_queued_tasks' sum
      if [[ $svc != adaptor ]]; then
        row db_pool_active       'hikaricp_connections_active' sum
        row db_pool_idle         'hikaricp_connections_idle' sum
        row db_pool_pending      'hikaricp_connections_pending' sum
        row db_pool_max          'hikaricp_connections_max' sum
        row db_acquire_max_ms    'hikaricp_connections_acquire_seconds_max' max 1000
        row db_usage_max_ms      'hikaricp_connections_usage_seconds_max' max 1000
        row db_timeouts_total    'hikaricp_connections_timeout_total' sum
      fi
      if [[ $svc == collector ]]; then
        row kafka_send_rate      'kafka_producer_record_send_rate' sum
        row kafka_errors_total   'kafka_producer_record_error_total' sum
        row kafka_latency_avg_ms 'kafka_producer_request_latency_avg' max
        row kafka_queue_avg_ms   'kafka_producer_record_queue_time_avg' max
        row kafka_buffer_free_bytes 'kafka_producer_buffer_available_bytes' sum
        row kafka_buffer_exhausted_total 'kafka_producer_buffer_exhausted_total' sum
      fi
      if [[ $svc == matcher ]]; then
        row events_processed_total 'cce_events_processed_total' sum
        row consumer_errors_total  'cce_consumer_inbound_errors_total' sum
        row event_max_ms           'cce_events_processing_duration_seconds_max' max 1000
      fi
      if [[ $svc == step-sla ]]; then
        row transitions_due        'cce_sla_transitions_due' sum
        row transitions_applied_total 'cce_sla_transitions_applied_total' sum
        row transitions_skipped_total 'cce_sla_transitions_skipped_total' sum
        row batches_failed_total   'cce_sla_evaluator_batches_failed_total' sum
      fi
    done

    if [[ -n "$PG_CTR" ]]; then
      docker exec "$PG_CTR" psql -U "$DB_USER" -d "$DB_NAME" -Atc \
        "SELECT coalesce(state, 'other'), count(*) FROM pg_stat_activity WHERE datname = '$DB_NAME' GROUP BY 1
         UNION ALL SELECT 'max_connections', setting::int FROM pg_settings WHERE name = 'max_connections'" 2>/dev/null |
        awk -F'|' -v ts="$ts" '{ gsub(/ /, "_", $1); printf "%s\tpostgres\tconnections_%s\t%s\n", ts, $1, $2 }'
    fi

    # One docker stats call for all containers: it takes about 2 s whatever the count.
    docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}' \
      $ADAPTOR_CTR $COLLECTOR_CTR $MATCHER_CTR $STEP_SLA_CTR $PG_CTR $KAFKA_CTR 2>/dev/null |
    while IFS='|' read -r c cpu mem net blk; do
      printf '%s\t%s\tcontainer_cpu_pct\t%s\n' "$ts" "$c" "${cpu%\%}"
      printf '%s\t%s\tcontainer_mem_bytes\t%s\n' "$ts" "$c" "$(to_bytes "${mem%% / *}")"
      printf '%s\t%s\tnet_in_total_bytes\t%s\n' "$ts" "$c" "$(to_bytes "${net%% / *}")"
      printf '%s\t%s\tnet_out_total_bytes\t%s\n' "$ts" "$c" "$(to_bytes "${net##* / }")"
      printf '%s\t%s\tdisk_read_total_bytes\t%s\n' "$ts" "$c" "$(to_bytes "${blk%% / *}")"
      printf '%s\t%s\tdisk_write_total_bytes\t%s\n' "$ts" "$c" "$(to_bytes "${blk##* / }")"
    done
  } >> "$OUT"
  sleep "$INTERVAL"
done
