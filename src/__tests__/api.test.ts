import { describe, expect, it, vi } from "vitest";
import {
  accessibleProjects,
  openSession,
  resolve,
  joinUrl,
  AUTOMATION_PREFIX,
  type FetchLike,
} from "../api.js";

function fakeResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

describe("joinUrl", () => {
  it("inserts the automation prefix and tolerates a trailing slash", () => {
    expect(joinUrl("https://api.reoclo.com/", "/secrets/resolve")).toBe(
      `https://api.reoclo.com${AUTOMATION_PREFIX}/secrets/resolve`,
    );
    expect(joinUrl("https://api.reoclo.com", "/secrets/resolve")).toBe(
      `https://api.reoclo.com${AUTOMATION_PREFIX}/secrets/resolve`,
    );
  });
});

describe("accessibleProjects", () => {
  it("GETs the accessible-projects path with a Bearer token and no body", async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(200, [{ id: "p1", name: "prod", access: "read" }]),
    ) as unknown as FetchLike;

    const out = await accessibleProjects(
      { apiUrl: "https://api.reoclo.com", token: "rca_x" },
      fetchFn,
    );

    expect(out).toEqual([{ id: "p1", name: "prod", access: "read" }]);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.reoclo.com/api/automation/v1/secrets/accessible-projects");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer rca_x");
    expect(init.body).toBeUndefined();
  });
});

describe("openSession", () => {
  it("POSTs project_ids plus ci meta as JSON", async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(200, {
        session_id: "s1",
        session_token: "rss_y",
        expires_at: "2026-08-02T00:00:00Z",
        project_ids: ["p1"],
      }),
    ) as unknown as FetchLike;

    const out = await openSession(
      { apiUrl: "https://api.reoclo.com", token: "rca_x" },
      ["p1"],
      { commit_sha: "abc", workflow_run_id: "42" },
      fetchFn,
    );

    expect(out.session_token).toBe("rss_y");
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      project_ids: ["p1"],
      commit_sha: "abc",
      workflow_run_id: "42",
    });
  });
});

describe("resolve", () => {
  it("POSTs project_ids with the session token and returns values", async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(200, { values: { DB: "secret" } }),
    ) as unknown as FetchLike;

    const out = await resolve(
      { apiUrl: "https://api.reoclo.com", token: "rss_y" },
      ["p1"],
      fetchFn,
    );

    expect(out.values).toEqual({ DB: "secret" });
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.headers.Authorization).toBe("Bearer rss_y");
    expect(JSON.parse(init.body)).toEqual({ project_ids: ["p1"] });
  });

  it("throws ApiError on a non-2xx response", async () => {
    const fetchFn = vi.fn(async () => fakeResponse(403, "forbidden")) as unknown as FetchLike;
    await expect(
      resolve({ apiUrl: "https://api.reoclo.com", token: "rss_y" }, ["p1"], fetchFn),
    ).rejects.toMatchObject({ name: "ApiError", status: 403, body: "forbidden" });
  });

  it("throws ApiError without echoing the body on a malformed 2xx", async () => {
    // A truncated body that carries plaintext secrets must not surface in the error.
    const fetchFn = vi.fn(async () =>
      fakeResponse(200, '{"values": {"DB": "super-secret'),
    ) as unknown as FetchLike;
    await expect(
      resolve({ apiUrl: "https://api.reoclo.com", token: "rss_y" }, ["p1"], fetchFn),
    ).rejects.toMatchObject({ name: "ApiError", body: "" });
    await expect(
      resolve({ apiUrl: "https://api.reoclo.com", token: "rss_y" }, ["p1"], fetchFn),
    ).rejects.toThrow(/malformed response body/);
  });
});
