/**
 * stub-load.test.js — placeholder k6 script of the stub service module (never run).
 *
 * What:    Exists only so the stub module's testFile('load') points at a real file; the runner maps it
 *          to /tests/tools/core/unit-tests/fixtures/stub-service/tests/stub-load.test.js in dry runs.
 * How:     Not meant to be run. (`k6 inspect` would accept it.)
 * Needs:   Nothing.
 * Outputs: Nothing.
 */
export const options = { vus: 1, iterations: 1 };

/** Does nothing; why: a valid k6 script needs a default function. */
export default function () {}
