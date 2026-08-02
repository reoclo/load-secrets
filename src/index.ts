// src/index.ts
//
// Reoclo Load Secrets — main entry. Resolves the secrets an automation key is
// granted and exports them into the workflow environment ($GITHUB_ENV) for
// subsequent steps, masking every value in the log first.

import * as core from "@actions/core";
import {
  accessibleProjects,
  openSession,
  resolve,
  type AccessibleProject,
  type ApiConfig,
  type CiMeta,
} from "./api.js";

const DEFAULT_API_URL = "https://api.reoclo.com";

/** Split a `projects` input into a clean list. Accepts newline- and/or
 *  comma-separated names or ids; trims and drops blanks. */
export function parseProjectsInput(raw: string): string[] {
  return (raw || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pick the project ids to resolve, mirroring `reoclo run`'s selectProjectIds
 * (cli/src/commands/run.ts):
 *  - no granted projects → actionable error (enabling "Read secrets" is not a grant);
 *  - no `wanted` filter → every granted project;
 *  - filter matches project name OR id;
 *  - a filter that matches nothing → error.
 * A project that is not granted and one that does not exist are reported the
 * same way, so a key cannot enumerate projects it cannot read.
 */
export function selectProjectIds(
  accessible: Pick<AccessibleProject, "id" | "name">[],
  wanted: string[],
): string[] {
  if (accessible.length === 0) {
    throw new Error(
      "this key is granted no secret projects. Enabling the 'Read secrets' " +
        "operation does not grant a project. Grant each project to this key " +
        "on the project's Access tab in the dashboard, then try again.",
    );
  }

  if (wanted.length === 0) return accessible.map((p) => p.id);

  const want = new Set(wanted);
  const ids = accessible.filter((p) => want.has(p.name) || want.has(p.id)).map((p) => p.id);
  if (ids.length === 0) {
    throw new Error(`no accessible secret project matched: ${wanted.join(", ")}`);
  }
  return ids;
}

/** Collect CI audit metadata for open-session, mirroring `reoclo run`'s
 *  collectCiMeta. `commitFlag` (the `commit` input) overrides GITHUB_SHA. */
export function collectCiMeta(
  env: Record<string, string | undefined>,
  commitFlag: string | undefined,
): CiMeta {
  const meta: CiMeta = {};
  const sha = commitFlag || env.GITHUB_SHA;
  if (sha) meta.commit_sha = sha;
  if (env.GITHUB_RUN_ID) meta.workflow_run_id = env.GITHUB_RUN_ID;
  return meta;
}

/** Compose the exported env-var name from an optional prefix and the secret key. */
export function buildEnvName(prefix: string, key: string): string {
  return `${prefix || ""}${key}`;
}

/** A POSIX-shell-safe environment variable name. Guards the comma-joined
 *  `loaded_keys` state (which the post step splits on `,`) and the
 *  `$GITHUB_ENV` file from a stray key containing `,`, `=`, or a newline. */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("api_key", { required: true });
    // Mask immediately, before any code path that could log or fail.
    core.setSecret(apiKey);

    const apiUrl = (core.getInput("api_url") || DEFAULT_API_URL).replace(/\/$/, "");
    const prefix = core.getInput("prefix");
    const cleanup = (core.getInput("cleanup") || "true") !== "false";
    const commitOverride = core.getInput("commit") || undefined;
    const wanted = parseProjectsInput(core.getInput("projects"));

    const keyCfg: ApiConfig = { apiUrl, token: apiKey };

    const accessible = await accessibleProjects(keyCfg);
    const ids = selectProjectIds(accessible, wanted);

    const meta = collectCiMeta(process.env, commitOverride);
    const session = await openSession(keyCfg, ids, meta);
    // The session token is a live rss_ credential that can resolve the granted
    // secrets until it expires — mask it the instant it exists.
    core.setSecret(session.session_token);

    // Re-resolve with the short-lived session token so the API records which
    // secrets this session consumed (matches `reoclo run`).
    const sessionCfg: ApiConfig = { apiUrl, token: session.session_token };
    const { values } = await resolve(sessionCfg, ids);

    const loadedNames: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      // Mask before anything can log or export it (empty needs no mask).
      if (value !== "") core.setSecret(value);
      const name = buildEnvName(prefix, key);
      if (!isValidEnvName(name)) {
        core.warning(
          `load-secrets: skipped secret "${key}" — "${name}" is not a valid environment variable name`,
        );
        continue;
      }
      core.exportVariable(name, value); // writes $GITHUB_ENV; value is not echoed
      loadedNames.push(name);
    }

    core.setOutput("session_id", session.session_id);
    core.setOutput("loaded_count", String(loadedNames.length));
    core.setOutput("loaded_keys", loadedNames.join(","));

    core.info(
      `Loaded ${loadedNames.length} secret(s) into the environment from ${ids.length} project(s).`,
    );

    // Wire the post step — only the non-sensitive names are saved.
    core.saveState("loaded_keys", loadedNames.join(","));
    core.saveState("cleanup", cleanup ? "true" : "false");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`load-secrets failed: ${message}`);
  }
}

// Only auto-run when executed directly (not when imported by tests).
if (process.env["VITEST"] !== "true") {
  run();
}
