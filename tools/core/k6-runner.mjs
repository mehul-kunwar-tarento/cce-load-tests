/**
 * k6-runner.mjs — runs one k6 test in the Docker image and stops it cleanly when asked.
 *
 * What:    k6 is not installed on the machine: every test runs in the image
 *          cce-load-tests/k6:2.3.0-kafka2.2.0 with the repository mounted at /tests. This module builds
 *          the exact `docker run` arguments (plan §6.3, §9.3): a container name k6-<runId> (so it can be
 *          stopped), the caller's uid:gid (results stay owned by you), the run context file, Prometheus
 *          remote write with run tags (Grafana), and the k6 REST API address the runner polls for the
 *          k6 clock. It streams k6's output into k6.log and stops k6 with SIGINT (k6 then still writes
 *          its summary).
 * How:     import { buildDockerArgs, runK6, stopK6, findFreePort } from './k6-runner.mjs';
 * Needs:   Docker and the k6 image (real runs only; unit tests only build arguments).
 * Outputs: docker arguments (string[]), k6.log, { exitCode, exitedAt }.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toIsoWithOffset } from './format.mjs';

/** Remote-write push interval (plan §9.3): matches Prometheus' 5 s scrape interval. */
const PUSH_INTERVAL = '5s';

/**
 * Picks a free TCP port on 127.0.0.1 for the k6 REST API.
 * Why: two runs (or another program) on the default 6565 would clash; the OS hands out a free one.
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Maps a test file (a module-relative file URL from testFile()) to its path inside the container.
 * Why: service modules return URLs relative to their own folder so the folder can be copied anywhere;
 * the container sees the repository at /tests (plan §6.4).
 * @param {URL|string} fileUrlOrPath
 * @param {string} repoRoot
 * @returns {string} e.g. '/tests/cce-collector-service/tests/collector-load.test.js'
 */
export function toContainerPath(fileUrlOrPath, repoRoot) {
  const absolute =
    fileUrlOrPath instanceof URL || String(fileUrlOrPath).startsWith('file:')
      ? fileURLToPath(fileUrlOrPath)
      : path.resolve(String(fileUrlOrPath));
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Test file ${absolute} is outside the repository ${repoRoot} (not visible in the container)`,
    );
  }
  return `/tests/${relative.split(path.sep).join('/')}`;
}

/**
 * Builds the full `docker run … k6 run …` argument list (plan §6.3, §9.3).
 * Why: one tested function decides every flag; `--dry-run` prints exactly what a real run executes.
 * @param {object} input
 * @param {object} input.environment loaded environment (k6.image, k6.dockerNetwork, monitoring)
 * @param {object} input.context run context (runId, subject, testType, k6.apiPort, resultsDirInContainer,
 *   planDefinitionSet.name, environment.name)
 * @param {Record<string, any>} input.settings ResolvedSettings.values
 * @param {string} input.scriptPath container path of the test script (toContainerPath)
 * @param {string} input.repoRoot folder mounted at /tests
 * @param {number} input.uid
 * @param {number} input.gid
 * @returns {string[]} arguments after "docker"
 */
export function buildDockerArgs({
  environment,
  context,
  settings,
  scriptPath,
  repoRoot,
  uid,
  gid,
}) {
  const network = environment.k6.dockerNetwork;
  const port = context.k6.apiPort;
  const args = ['run', '--rm', '--name', `k6-${context.runId}`, '--network', network];
  args.push('-u', `${uid}:${gid}`, '-v', `${repoRoot}:/tests`, '-w', '/tests');
  // On the host network the API listens on loopback only; elsewhere it is published to loopback.
  const address = network === 'host' ? `127.0.0.1:${port}` : `0.0.0.0:${port}`;
  if (network !== 'host') args.push('-p', `127.0.0.1:${port}:${port}`);
  args.push('-e', `RUN_CONTEXT=${context.resultsDirInContainer}/run-context.json`);
  const remoteWrite = Boolean(environment.monitoring?.enabled && settings.PROMETHEUS_REMOTE_WRITE);
  if (remoteWrite) {
    args.push(
      '-e',
      `K6_PROMETHEUS_RW_SERVER_URL=${environment.monitoring.remoteWriteUrl}`,
      '-e',
      `K6_PROMETHEUS_RW_TREND_STATS=${settings.K6_TREND_STATS}`,
      '-e',
      'K6_PROMETHEUS_RW_STALE_MARKERS=true',
      '-e',
      `K6_PROMETHEUS_RW_PUSH_INTERVAL=${PUSH_INTERVAL}`,
    );
  }
  args.push(environment.k6.image, 'run');
  if (remoteWrite) args.push('-o', 'experimental-prometheus-rw');
  // Labels on every k6 series, identical to the Grafana dashboard variables (plan §9.3).
  const tags = {
    testid: context.runId,
    service: context.subject,
    test_type: context.testType,
    plan_definition_set: context.planDefinitionSet?.name ?? settings.PLAN_DEFINITION_SET,
    environment: context.environment?.name ?? environment.name,
  };
  for (const [name, value] of Object.entries(tags)) args.push('--tag', `${name}=${value}`);
  args.push('--address', address, scriptPath);
  return args;
}

/**
 * The docker command as one printable line, with secrets masked.
 * Why: printed at the start of every run (plan §3.4); a password-like value must never be shown.
 * @param {string[]} args
 * @returns {string}
 */
export function formatDockerCommand(args) {
  const masked = args.map((arg) =>
    /(PASSWORD|TOKEN|SECRET)[^=]*=/i.test(arg) ? arg.replace(/=.*/, '=***') : arg,
  );
  // Quote arguments with spaces or shell characters so the line can be copied into a shell.
  return ['docker', ...masked]
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg}'`))
    .join(' ');
}

/**
 * Runs docker with the given arguments, streaming every output line to k6.log and onLine.
 * Why: the console shows k6 progress live, and the log stays with the results.
 * @param {string[]} args from buildDockerArgs
 * @param {{logFile:string, onLine?:(line:string)=>void, spawnFn?: typeof spawn, onStart?:()=>void}} options
 * @returns {Promise<{exitCode:number, exitedAt:string, startedAt:string}>}
 */
export function runK6(args, { logFile, onLine = () => {}, spawnFn = spawn, onStart = () => {} }) {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const startedAt = toIsoWithOffset(new Date());
    const child = spawnFn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onStart();
    // k6 writes progress with carriage returns; split on both so each update becomes a line.
    const forward = (chunk) => {
      log.write(chunk);
      for (const line of String(chunk).split(/\r?\n|\r/)) if (line.trim()) onLine(line);
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('error', (error) => {
      log.end();
      reject(error);
    });
    child.on('close', (code, signal) => {
      log.end();
      // A signal without a code (docker killed) is reported as 130, like a shell would.
      resolve({
        exitCode: code ?? (signal ? 130 : 1),
        exitedAt: toIsoWithOffset(new Date()),
        startedAt,
      });
    });
  });
}

/**
 * Asks k6 to stop: SIGINT to the container k6-<runId>.
 * Why: SIGINT makes k6 end gracefully and still run handleSummary (k6-summary.json); a plain
 * `docker stop` (SIGTERM, then SIGKILL) could lose the summary (plan §6.2 step 8).
 * @param {string} runId
 * @param {{execFileFn?: typeof execFile}} [options]
 * @returns {Promise<void>}
 */
export function stopK6(runId, { execFileFn = execFile } = {}) {
  return new Promise((resolve) => {
    execFileFn('docker', ['kill', '--signal', 'SIGINT', `k6-${runId}`], () => resolve());
  });
}
