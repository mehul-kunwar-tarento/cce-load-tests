/**
 * plan-definition-set.mjs — preflight check `plan-definition-set`: the chosen set is ACTIVE, and what else is
 *
 * What:    Every plan definition of PLAN_DEFINITION_SET must be ACTIVE (protocol API by url + version).
 *          Overlap: other ACTIVE plan definitions that the matcher would also start for the test events
 *          enrol every test patient too, so the matcher does more work than the set says ("effective
 *          fan-out"). Found with ONE read-only query on trigger_index ⋈ protocol_definition that applies the
 *          matcher's own Tier 1 rule (TriggerIndexRepository.findStructuralMatches): per event, an action
 *          matches only when EVERY codeFilter path of it is satisfied (GROUP BY definition, action HAVING
 *          all paths). The event tuples come only from the template(s) the run really sends:
 *          EVENT_ACTION_ID (empty = the dataset's defaultActionId), or every template with EVENT_MODE=journey.
 *          Condition-only (Tier 2) triggers are not in trigger_index: the matcher evaluates them for every
 *          event. Other ACTIVE definitions that have one are listed with matchesDatasetEvents null
 *          ("unknown", a warning) and are NOT counted in the effective fan-out.
 *          Rule: overlap fails for the matcher unless ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true (then a
 *          warning); a set marked exclusive fails regardless; collector/Step SLA only warn.
 * How:     Listed in checks/index.mjs.
 * Needs:   test-data (set + dataset), ctx.clients.protocolApi, ctx.clients.db (overlap; optional).
 * Outputs: data = { name, fanOut, effectiveFanOut, exclusive, loadTestMarker, planDefinitions[],
 *          otherActivePlanDefinitions[], overlapMeasured, eventTemplates[] } — copied into
 *          result.conditions.planDefinitionSet by run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findResources, matchTuples } from '../../plan-definitions/triggers.mjs';
import { datasetForRun } from '../../core/run-setup.mjs';
import { hasLoadTestMarker, loadPlanDefinitionSet } from '../../plan-definitions/sets.mjs';
import { fail, isStatementTimeout, pass, testsSubject, warn } from '../check-helpers.mjs';

/**
 * Read-only overlap query, the matcher's Tier 1 rule in SQL.
 * $1 event numbers, $2..$5 the event tuples (resource type, path, code system, code value), $6 the set's
 * own canonicals (url|version). Per event: the trigger rows the event hits, grouped by (definition,
 * action, resource type), must cover every distinct path|system that action has for that resource type
 * (the same COUNT(DISTINCT path || '|' || system) comparison as findStructuralMatches).
 */
export const OVERLAP_SQL = `WITH e AS (
  SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[])
    AS e(event_no, resource_type, path, code_system, code_value)
), hits AS (
  SELECT e.event_no, ti.protocol_definition_id, ti.action_id, ti.resource_type,
         count(DISTINCT ti.path || '|' || ti.code_system) AS paths_hit
  FROM trigger_index ti
  JOIN e ON ti.resource_type = e.resource_type AND ti.path = e.path
        AND ti.code_system = e.code_system AND ti.code_value = e.code_value
  GROUP BY e.event_no, ti.protocol_definition_id, ti.action_id, ti.resource_type
)
SELECT DISTINCT pd.id::text AS id, pd.url, pd.version, pd.status
FROM hits h
JOIN protocol_definition pd ON pd.id = h.protocol_definition_id
WHERE pd.status = 'ACTIVE' AND NOT ((pd.url || '|' || pd.version) = ANY($6::text[]))
  AND h.paths_hit = (
    SELECT count(DISTINCT t2.path || '|' || t2.code_system)
    FROM trigger_index t2
    WHERE t2.protocol_definition_id = h.protocol_definition_id
      AND t2.action_id = h.action_id
      AND t2.resource_type = h.resource_type)
ORDER BY pd.url, pd.version`;

/**
 * Other ACTIVE definitions with a condition-only (Tier 2) trigger: a trigger without data[] but with a
 * condition (PlanDefinitionParser.extractConditionOnlyTriggers). $1 = the set's own canonicals.
 * Why: Tier 2 triggers live in the matcher's memory, not in trigger_index, and their FHIRPath condition
 * cannot be judged here; such a definition MAY also enrol test patients, so it is reported as "unknown".
 */
export const CONDITION_ONLY_SQL = `SELECT pd.id::text AS id, pd.url, pd.version, pd.status
FROM protocol_definition pd
WHERE pd.status = 'ACTIVE' AND NOT ((pd.url || '|' || pd.version) = ANY($1::text[]))
  AND jsonb_path_exists(pd.definition, 'lax $.**.trigger[*] ? (!exists(@.data[*]) && exists(@.condition))')
ORDER BY pd.url, pd.version`;

/**
 * The event templates the run sends, as FHIR resources, with their action ids.
 * Why: only the codes of what is really sent can make another definition match; with EVENT_MODE=single
 *      (the only mode now) that is the EVENT_ACTION_ID template, default the dataset's defaultActionId.
 *      DATASET empty = the set's first compatible dataset (as a run resolves it).
 * @param {object} ctx
 * @param {{compatibleDatasets?: string[]}|null} [set] the loaded plan-definition set
 * @returns {{templates: Array<{actionId:string, resource:object}>, problem: string|null}}
 */
export function sentTemplates(ctx, set = null) {
  const name = datasetForRun(ctx.settings.DATASET, set);
  if (!name) return { templates: [], problem: 'no DATASET set' };
  const file = path.join(ctx.testDataRoot, 'datasets', name, 'dataset.json');
  if (!fs.existsSync(file)) return { templates: [], problem: `dataset ${name} not found` };
  const dataset = JSON.parse(fs.readFileSync(file, 'utf8'));
  const all = dataset.eventTemplates ?? {};
  const ids =
    ctx.settings.EVENT_MODE === 'journey'
      ? Object.keys(all)
      : [ctx.settings.EVENT_ACTION_ID || dataset.defaultActionId].filter(Boolean);
  const templates = [];
  for (const actionId of ids) {
    // findResources skips $comment-only wrappers and finds the FHIR resource inside a template.
    const [resource] = findResources(all[actionId] ?? null);
    if (resource) templates.push({ actionId, resource });
  }
  return templates.length
    ? { templates, problem: null }
    : {
        templates,
        problem: `dataset ${name} has no event template for ${ids.join(', ') || '(none)'}`,
      };
}

export default {
  id: 'plan-definition-set',
  title:
    'Plan-definition set ACTIVE; no other ACTIVE plan definition matches the events the run sends',
  appliesTo: (ctx) => Boolean(ctx.planDefinitionSetName),
  severity: () => 'required',
  async run(ctx) {
    const set = await loadPlanDefinitionSet(ctx.planDefinitionSetName, {
      versionSuffix: ctx.settings.PLAN_DEFINITION_VERSION_SUFFIX ?? '',
      testDataRoot: ctx.testDataRoot,
    });
    const api = ctx.clients.protocolApi;
    if (!api)
      return fail('no protocol API client (services.protocol in the environment file?)', {
        name: set.name,
      });

    // 1. Every definition of the set ACTIVE (lookup by url + version, as the matcher sees it).
    const planDefinitions = [];
    for (const pd of set.planDefinitions) {
      const found = await api.getByUrlVersion(pd.url, pd.version);
      planDefinitions.push({
        name: pd.name,
        url: pd.url,
        version: pd.version,
        canonical: pd.canonical,
        status: found?.status ?? 'MISSING',
        id: found?.id ?? null,
        updatedAt: found?.loadedAt ?? null,
        mandatorySteps: pd.mandatorySteps,
        loadTestMarker: hasLoadTestMarker(found?.definition),
      });
    }
    const data = {
      name: set.name,
      fanOut: set.fanOut,
      effectiveFanOut: set.fanOut,
      exclusive: set.exclusive,
      loadTestMarker: planDefinitions.every((p) => p.loadTestMarker),
      planDefinitions,
      otherActivePlanDefinitions: [],
      overlapMeasured: false,
      eventTemplates: [],
    };
    const notActive = planDefinitions.filter((p) => p.status !== 'ACTIVE');
    if (notActive.length) {
      return fail(
        `${notActive.map((p) => `${p.canonical} is ${p.status}`).join('; ')}: run plan-definitions load ${ctx.environment.name} --set ${set.name}`,
        data,
      );
    }

    // 2. Overlap: other ACTIVE definitions the matcher would also start for the events this run sends.
    if (!ctx.clients.db)
      return warn(`all ${set.fanOut} ACTIVE; overlap not measured (no database connection)`, data);
    const { templates, problem } = sentTemplates(ctx, set);
    data.eventTemplates = templates.map((t) => t.actionId);
    if (problem) return warn(`all ${set.fanOut} ACTIVE; overlap not measured (${problem})`, data);
    const tuples = matchTuples({ resources: templates.map((t) => t.resource) });
    const own = set.planDefinitions.map((p) => p.canonical);
    let others;
    let conditionOnly;
    try {
      others = await ctx.clients.db.query(
        OVERLAP_SQL,
        [
          tuples.map((t) => t.eventNo),
          tuples.map((t) => t.resourceType),
          tuples.map((t) => t.path),
          tuples.map((t) => t.codeSystem),
          tuples.map((t) => t.codeValue),
          own,
        ],
        { statementTimeoutMs: 5000 },
      );
      conditionOnly = await ctx.clients.db.query(CONDITION_ONLY_SQL, [own], {
        statementTimeoutMs: 5000,
      });
    } catch (error) {
      if (isStatementTimeout(error))
        return warn(`all ${set.fanOut} ACTIVE; overlap not measured (query timed out)`, data);
      throw error;
    }
    data.overlapMeasured = true;
    const matched = new Set(others.map((o) => o.id));
    data.otherActivePlanDefinitions = [
      ...others.map((o) => ({
        id: o.id,
        canonical: `${o.url}|${o.version}`,
        status: o.status,
        matchesDatasetEvents: true,
        note: null,
      })),
      // A definition already matched structurally is counted once; the rest are "unknown".
      ...conditionOnly
        .filter((o) => !matched.has(o.id))
        .map((o) => ({
          id: o.id,
          canonical: `${o.url}|${o.version}`,
          status: o.status,
          matchesDatasetEvents: null,
          note: 'condition-only (Tier 2) trigger: evaluated for every event, may match; not counted',
        })),
    ];
    data.effectiveFanOut = set.fanOut + others.length;
    const unknown = data.otherActivePlanDefinitions.filter((o) => o.matchesDatasetEvents === null);
    const unknownText = unknown.length
      ? `${unknown.length} other ACTIVE plan definition(s) have condition-only triggers that may also match (not counted in the effective fan-out): ${unknown.map((o) => o.canonical).join(', ')}`
      : '';
    if (others.length === 0) {
      return unknown.length
        ? warn(`all ${set.fanOut} ACTIVE; ${unknownText}`, data)
        : pass(`all ${set.fanOut} ACTIVE, no other ACTIVE plan definition matches`, data);
    }

    const list = others.map((o) => `${o.url}|${o.version}`).join(', ');
    const detail = `${others.length} other ACTIVE plan definition(s) match the events this run sends (${data.eventTemplates.join(', ')}; effective fan-out ${data.effectiveFanOut}): ${list}${unknownText ? `; ${unknownText}` : ''}`;
    if (set.exclusive && !ctx.stackCheck)
      return fail(`${detail}; set ${set.name} is exclusive`, data);
    if (testsSubject(ctx, 'matcher') && !ctx.settings.ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS) {
      return fail(
        `${detail}; retire them by hand or set ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true`,
        data,
      );
    }
    return warn(detail, data);
  },
};
