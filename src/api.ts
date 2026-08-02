// src/api.ts
//
// Thin HTTP client for the Reoclo automation secrets surface — the same three
// endpoints `reoclo run` uses (cli/src/commands/run.ts). Automation keys hit
// the dedicated `/api/automation/v1/*` route with `Authorization: Bearer`.
//
// `fetch` is injectable so the whole action is unit-testable without a live API
// or a network hop.

const AUTOMATION_PREFIX = "/api/automation/v1";

export type FetchLike = typeof fetch;

export interface ApiConfig {
  /** Base API URL, e.g. https://api.reoclo.com (trailing slash tolerated). */
  apiUrl: string;
  /** Automation key (rca_…) or short-lived session key (rss_…). */
  token: string;
}

export interface AccessibleProject {
  id: string;
  name: string;
  access: "read" | "read_write";
}

export interface CiMeta {
  commit_sha?: string;
  workflow_run_id?: string;
}

export interface OpenSessionResponse {
  session_id: string;
  session_token: string;
  expires_at: string;
  project_ids: string[];
}

export interface ResolveResponse {
  values: Record<string, string>;
}

/** Raised on any non-2xx response. `body` is the raw response text (never
 *  contains secret values — only `resolve` returns values, and only on 2xx). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function joinUrl(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/$/, "")}${AUTOMATION_PREFIX}${path}`;
}

async function request<T>(
  cfg: ApiConfig,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  fetchFn: FetchLike,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetchFn(joinUrl(cfg.apiUrl, path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      text,
      `reoclo secrets API ${method} ${path} failed (HTTP ${res.status})`,
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Never echo the body: on the resolve path a 2xx body carries plaintext
    // secrets, and they have not been masked yet at this point.
    throw new ApiError(
      res.status,
      "",
      `reoclo secrets API ${method} ${path} returned a malformed response body`,
    );
  }
}

/** List the secret projects this key is granted (machine surface). */
export function accessibleProjects(
  cfg: ApiConfig,
  fetchFn: FetchLike = fetch,
): Promise<AccessibleProject[]> {
  return request<AccessibleProject[]>(
    cfg,
    "GET",
    "/secrets/accessible-projects",
    undefined,
    fetchFn,
  );
}

/** Open a resolution session (mints a short-lived rss_ token) and record CI
 *  audit metadata. Resolve must be called with the returned session_token. */
export function openSession(
  cfg: ApiConfig,
  projectIds: string[],
  meta: CiMeta,
  fetchFn: FetchLike = fetch,
): Promise<OpenSessionResponse> {
  return request<OpenSessionResponse>(
    cfg,
    "POST",
    "/secrets/open-session",
    { project_ids: projectIds, ...meta },
    fetchFn,
  );
}

/** Resolve every secret in the given projects to a flat KEY→value map. Call
 *  with the session token from {@link openSession} so consumption is audited. */
export function resolve(
  cfg: ApiConfig,
  projectIds: string[],
  fetchFn: FetchLike = fetch,
): Promise<ResolveResponse> {
  return request<ResolveResponse>(
    cfg,
    "POST",
    "/secrets/resolve",
    { project_ids: projectIds },
    fetchFn,
  );
}

export { AUTOMATION_PREFIX, joinUrl };
