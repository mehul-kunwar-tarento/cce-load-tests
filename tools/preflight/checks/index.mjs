/**
 * index.mjs — the ordered list of preflight checks (plan §7.1)
 *
 * What:    Returns every check for one preflight run, in the order they are run and printed. Per-service
 *          checks (service-health.<subject>, service-metrics.<subject>) are expanded for the services this
 *          run needs, so check ids always carry the SUBJECT (e.g. service-health.step-sla).
 * How:     import { buildChecks } from './checks/index.mjs'; buildChecks(ctx)
 * Needs:   The preflight context (subjects, environment).
 * Outputs: Check modules { id, title, appliesTo(ctx), severity(ctx), run(ctx) }.
 */
import autovacuum from './autovacuum.mjs';
import diskDataStores from './disk-data-stores.mjs';
import diskResults from './disk-results.mjs';
import docker from './docker.mjs';
import environment from './environment.mjs';
import kafka from './kafka.mjs';
import leftoverTestData from './leftover-test-data.mjs';
import matcherConsumerGroup from './matcher-consumer-group.mjs';
import monitoring from './monitoring.mjs';
import planDefinitionSet from './plan-definition-set.mjs';
import postgres from './postgres.mjs';
import postgresTarget from './postgres-target.mjs';
import schemaStepGroups from './schema-step-groups.mjs';
import * as serviceHealth from './service-health.mjs';
import * as serviceMetrics from './service-metrics.mjs';
import stepSlaScheduler from './step-sla-scheduler.mjs';
import walAndSlots from './wal-and-slots.mjs';

/** Every fixed check id (the per-service ones are listed by their template). Used by docs and tests. */
export const CHECK_IDS = [
  'environment',
  'docker',
  'service-health.<subject>',
  'service-metrics.<subject>',
  'postgres',
  'postgres-target',
  'schema-step-groups',
  'kafka',
  'matcher-consumer-group',
  'plan-definition-set',
  'disk.results',
  'disk.data-stores',
  'wal-and-slots',
  'autovacuum',
  'leftover-test-data',
  'step-sla-scheduler',
  'monitoring',
];

/** Build the run's check list. Why: cheap, decisive checks first; slow ones (scheduler waits) last. */
export function buildChecks(ctx) {
  return [
    environment,
    docker,
    ...serviceHealth.healthSubjects(ctx).map(serviceHealth.forSubject),
    ...serviceMetrics.metricsSubjects(ctx).map(serviceMetrics.forSubject),
    postgres,
    postgresTarget,
    schemaStepGroups,
    kafka,
    matcherConsumerGroup,
    planDefinitionSet,
    diskResults,
    diskDataStores,
    walAndSlots,
    autovacuum,
    leftoverTestData,
    stepSlaScheduler,
    monitoring,
  ];
}
