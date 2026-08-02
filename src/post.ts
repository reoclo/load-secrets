// src/post.ts
//
// Post-job cleanup. Overwrites each loaded secret with an empty value in
// $GITHUB_ENV at job end. This is best-effort defense-in-depth: it keeps the
// plaintext from persisting into later post-steps or job state. It does not
// scrub steps that already ran (they are complete), and every value is masked
// in the log for the whole job regardless of this step. Never fails the job.

import * as core from "@actions/core";

export async function post(): Promise<void> {
  if (core.getState("cleanup") !== "true") return;

  const raw = core.getState("loaded_keys");
  if (!raw) return;

  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return;

  for (const name of names) {
    try {
      core.exportVariable(name, "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`load-secrets cleanup: could not unset ${name}: ${message}`);
    }
  }
  core.info(`Unset ${names.length} loaded secret(s) from the environment.`);
}

// Only auto-run when executed directly (not when imported by tests).
if (process.env["VITEST"] !== "true") {
  post();
}
