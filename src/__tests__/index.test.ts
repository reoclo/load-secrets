import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
  exportVariable: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  saveState: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@actions/core", () => core);

const api = vi.hoisted(() => ({
  accessibleProjects: vi.fn(),
  openSession: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("../api.js", () => api);

import {
  run,
  parseProjectsInput,
  selectProjectIds,
  collectCiMeta,
  buildEnvName,
  isValidEnvName,
} from "../index.js";

// --- pure helpers -----------------------------------------------------------

describe("parseProjectsInput", () => {
  it("splits on newlines and commas, trims, drops blanks", () => {
    expect(parseProjectsInput("prod, staging\n\n  db ")).toEqual(["prod", "staging", "db"]);
    expect(parseProjectsInput("")).toEqual([]);
  });
});

describe("selectProjectIds", () => {
  const accessible = [
    { id: "p1", name: "prod" },
    { id: "p2", name: "staging" },
  ];

  it("returns every id when no filter is given", () => {
    expect(selectProjectIds(accessible, [])).toEqual(["p1", "p2"]);
  });

  it("matches by name or by id", () => {
    expect(selectProjectIds(accessible, ["prod"])).toEqual(["p1"]);
    expect(selectProjectIds(accessible, ["p2"])).toEqual(["p2"]);
  });

  it("throws an actionable error when the key is granted nothing", () => {
    expect(() => selectProjectIds([], [])).toThrow(/granted no secret projects/);
  });

  it("throws when the filter matches no accessible project", () => {
    expect(() => selectProjectIds(accessible, ["nope"])).toThrow(
      /no accessible secret project matched/,
    );
  });
});

describe("collectCiMeta", () => {
  it("uses GITHUB_SHA and GITHUB_RUN_ID", () => {
    expect(collectCiMeta({ GITHUB_SHA: "abc", GITHUB_RUN_ID: "42" }, undefined)).toEqual({
      commit_sha: "abc",
      workflow_run_id: "42",
    });
  });

  it("lets the commit override win over GITHUB_SHA", () => {
    expect(collectCiMeta({ GITHUB_SHA: "abc" }, "override")).toEqual({ commit_sha: "override" });
  });

  it("omits fields that are absent", () => {
    expect(collectCiMeta({}, undefined)).toEqual({});
  });
});

describe("buildEnvName", () => {
  it("prepends the prefix", () => {
    expect(buildEnvName("APP_", "DB")).toBe("APP_DB");
    expect(buildEnvName("", "DB")).toBe("DB");
  });
});

describe("isValidEnvName", () => {
  it("accepts shell-safe names", () => {
    expect(isValidEnvName("DB_URL")).toBe(true);
    expect(isValidEnvName("_x0")).toBe(true);
  });
  it("rejects names with unsafe characters or a leading digit", () => {
    for (const bad of ["BAD-NAME", "A=B", "A,B", "A\nB", "1ABC", "", "A B"]) {
      expect(isValidEnvName(bad)).toBe(false);
    }
  });
});

// --- run() ------------------------------------------------------------------

function inputs(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    api_key: "rca_test",
    api_url: "",
    prefix: "",
    cleanup: "",
    commit: "",
    projects: "",
  };
  const merged = { ...base, ...overrides };
  core.getInput.mockImplementation((name: string) => merged[name] ?? "");
}

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_SHA;
    delete process.env.GITHUB_RUN_ID;
    inputs();
    api.accessibleProjects.mockResolvedValue([
      { id: "p1", name: "prod", access: "read" },
      { id: "p2", name: "staging", access: "read" },
    ]);
    api.openSession.mockResolvedValue({
      session_id: "sess-1",
      session_token: "rss_sess",
      expires_at: "t",
      project_ids: ["p1", "p2"],
    });
    api.resolve.mockResolvedValue({
      values: { DB_URL: "postgres://secret", API_TOKEN: "tok" },
    });
  });

  it("masks the key + each value, exports them, and sets outputs/state", async () => {
    process.env.GITHUB_SHA = "sha123";
    process.env.GITHUB_RUN_ID = "run99";

    await run();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setSecret).toHaveBeenCalledWith("rca_test");
    expect(core.setSecret).toHaveBeenCalledWith("postgres://secret");
    expect(core.setSecret).toHaveBeenCalledWith("tok");

    expect(core.exportVariable).toHaveBeenCalledWith("DB_URL", "postgres://secret");
    expect(core.exportVariable).toHaveBeenCalledWith("API_TOKEN", "tok");

    expect(core.setOutput).toHaveBeenCalledWith("session_id", "sess-1");
    expect(core.setOutput).toHaveBeenCalledWith("loaded_count", "2");
    expect(core.setOutput).toHaveBeenCalledWith("loaded_keys", "DB_URL,API_TOKEN");

    expect(core.saveState).toHaveBeenCalledWith("loaded_keys", "DB_URL,API_TOKEN");
    expect(core.saveState).toHaveBeenCalledWith("cleanup", "true");

    // open-session carries the CI audit metadata, keyed on the automation key
    expect(api.openSession).toHaveBeenCalledWith(
      { apiUrl: "https://api.reoclo.com", token: "rca_test" },
      ["p1", "p2"],
      { commit_sha: "sha123", workflow_run_id: "run99" },
    );
    // resolve runs under the short-lived session token
    expect(api.resolve).toHaveBeenCalledWith(
      { apiUrl: "https://api.reoclo.com", token: "rss_sess" },
      ["p1", "p2"],
    );
  });

  it("masks the short-lived session token", async () => {
    await run();
    expect(core.setSecret).toHaveBeenCalledWith("rss_sess");
  });

  it("masks each value before it is exported", async () => {
    await run();
    const maskIdx = core.setSecret.mock.calls.findIndex((c) => c[0] === "postgres://secret");
    const exportIdx = core.exportVariable.mock.calls.findIndex((c) => c[0] === "DB_URL");
    expect(maskIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(core.setSecret.mock.invocationCallOrder[maskIdx]!).toBeLessThan(
      core.exportVariable.mock.invocationCallOrder[exportIdx]!,
    );
  });

  it("skips a secret whose env-var name is invalid and warns, still loading the rest", async () => {
    api.resolve.mockResolvedValue({ values: { "BAD-NAME": "x", GOOD: "y" } });
    await run();
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.warning.mock.calls[0]?.[0]).toMatch(/BAD-NAME/);
    expect(core.exportVariable).not.toHaveBeenCalledWith("BAD-NAME", "x");
    expect(core.exportVariable).toHaveBeenCalledWith("GOOD", "y");
    expect(core.setOutput).toHaveBeenCalledWith("loaded_keys", "GOOD");
    expect(core.setOutput).toHaveBeenCalledWith("loaded_count", "1");
    // the skipped value is still masked defensively
    expect(core.setSecret).toHaveBeenCalledWith("x");
  });

  it("filters to the requested projects by name", async () => {
    inputs({ projects: "staging" });
    await run();
    expect(api.openSession).toHaveBeenCalledWith(expect.anything(), ["p2"], expect.anything());
  });

  it("applies the prefix to exported names and loaded_keys", async () => {
    inputs({ prefix: "CI_" });
    await run();
    expect(core.exportVariable).toHaveBeenCalledWith("CI_DB_URL", "postgres://secret");
    expect(core.exportVariable).toHaveBeenCalledWith("CI_API_TOKEN", "tok");
    expect(core.setOutput).toHaveBeenCalledWith("loaded_keys", "CI_DB_URL,CI_API_TOKEN");
  });

  it("honors a custom api_url and the commit override", async () => {
    process.env.GITHUB_SHA = "sha123";
    inputs({ api_url: "https://api.self-hosted.example/", commit: "override-sha" });
    await run();
    expect(api.accessibleProjects).toHaveBeenCalledWith({
      apiUrl: "https://api.self-hosted.example",
      token: "rca_test",
    });
    expect(api.openSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      commit_sha: "override-sha",
    });
  });

  it("fails with an actionable message when the key has no grants", async () => {
    api.accessibleProjects.mockResolvedValue([]);
    await run();
    expect(core.setFailed).toHaveBeenCalledOnce();
    expect(core.setFailed.mock.calls[0]?.[0]).toMatch(/granted no secret projects/);
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it("records cleanup=false when the cleanup input is 'false'", async () => {
    inputs({ cleanup: "false" });
    await run();
    expect(core.saveState).toHaveBeenCalledWith("cleanup", "false");
  });

  it("does not mask an empty value but still exports it", async () => {
    api.resolve.mockResolvedValue({ values: { EMPTY: "" } });
    await run();
    expect(core.setSecret).not.toHaveBeenCalledWith("");
    expect(core.exportVariable).toHaveBeenCalledWith("EMPTY", "");
  });

  it("routes a thrown API error through setFailed", async () => {
    api.accessibleProjects.mockRejectedValue(new Error("HTTP 401"));
    await run();
    expect(core.setFailed).toHaveBeenCalledOnce();
    expect(core.setFailed.mock.calls[0]?.[0]).toMatch(/load-secrets failed: HTTP 401/);
  });
});
