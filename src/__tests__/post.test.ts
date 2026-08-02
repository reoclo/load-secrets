import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  getState: vi.fn(),
  exportVariable: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@actions/core", () => core);

import { post } from "../post.js";

function setState(state: Record<string, string>) {
  core.getState.mockImplementation((k: string) => state[k] ?? "");
}

describe("post cleanup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unsets each loaded key when cleanup is true", async () => {
    setState({ cleanup: "true", loaded_keys: "DB_URL,API_TOKEN" });
    await post();
    expect(core.exportVariable).toHaveBeenCalledWith("DB_URL", "");
    expect(core.exportVariable).toHaveBeenCalledWith("API_TOKEN", "");
    expect(core.exportVariable).toHaveBeenCalledTimes(2);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("skips when cleanup is not true", async () => {
    setState({ cleanup: "false", loaded_keys: "DB_URL" });
    await post();
    expect(core.exportVariable).not.toHaveBeenCalled();
  });

  it("skips when there are no loaded keys", async () => {
    setState({ cleanup: "true", loaded_keys: "" });
    await post();
    expect(core.exportVariable).not.toHaveBeenCalled();
  });

  it("warns but never throws when an unset fails", async () => {
    setState({ cleanup: "true", loaded_keys: "DB_URL" });
    core.exportVariable.mockImplementation(() => {
      throw new Error("boom");
    });
    await post();
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.warning.mock.calls[0]?.[0]).toMatch(/could not unset DB_URL/);
  });
});
