import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listPendingStarTargets,
  markTargetError,
  markTargetStarred,
} from "../../../packages/database/src/star-aid.js";
import { decryptToken } from "./encrypt.js";
import { starGitHubRepo } from "./github.js";
import { starAidSweep } from "./sweep.js";

vi.mock("../../../packages/database/src/schema.js", () => ({
  starAidAccounts: { id: "id", encryptedToken: "encrypted_token" },
}));

vi.mock("../../../packages/database/src/star-aid.js", () => ({
  listPendingStarTargets: vi.fn(),
  markTargetStarred: vi.fn(),
  markTargetError: vi.fn(),
}));

vi.mock("./encrypt.js", () => ({
  decryptToken: vi.fn(),
}));

vi.mock("./github.js", () => ({
  starGitHubRepo: vi.fn(),
}));

const accountId = "acc-1";

function target(id: string, fullName: string) {
  const now = new Date("2026-08-01T00:00:00Z");
  return {
    id,
    accountId,
    fullName,
    description: "",
    starred: false,
    starredAt: null,
    lastError: null,
    lastCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** A fake db whose select().from().where() returns the account token rows. */
function fakeDb(
  rows: { id: string; encryptedToken: string }[] = [
    { id: accountId, encryptedToken: "sealed-token" },
  ],
) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as never;
}

const deps = {
  cipher: { open: (s: string) => s, seal: (s: string) => s },
  apiBaseUrl: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(decryptToken).mockImplementation((_cipher, sealed) => sealed);
  vi.mocked(starGitHubRepo).mockResolvedValue(true);
  vi.mocked(markTargetStarred).mockResolvedValue(undefined);
  vi.mocked(markTargetError).mockResolvedValue(undefined);
});

describe("starAidSweep", () => {
  it("stars every pending target and reports the tallies", async () => {
    vi.mocked(listPendingStarTargets).mockResolvedValue([
      target("t1", "owner/repo-a"),
      target("t2", "owner/repo-b"),
    ]);
    const result = await starAidSweep(fakeDb(), deps);
    expect(result).toEqual({ processed: 2, starred: 2, failed: 0 });
    expect(starGitHubRepo).toHaveBeenCalledTimes(2);
    expect(starGitHubRepo).toHaveBeenNthCalledWith(
      1,
      undefined,
      "sealed-token",
      "owner",
      "repo-a",
    );
    expect(starGitHubRepo).toHaveBeenNthCalledWith(
      2,
      undefined,
      "sealed-token",
      "owner",
      "repo-b",
    );
    expect(markTargetStarred).toHaveBeenCalledTimes(2);
    expect(markTargetError).not.toHaveBeenCalled();
  });

  it("records failures per target without aborting the sweep", async () => {
    vi.mocked(listPendingStarTargets).mockResolvedValue([
      target("t1", "owner/repo-a"),
      target("t2", "owner/repo-b"),
      target("t3", "owner/repo-c"),
    ]);
    vi.mocked(starGitHubRepo).mockImplementation(async (_base, _tok, owner, repo) => {
      if (repo === "repo-b") throw new Error("boom");
      return true;
    });
    const result = await starAidSweep(fakeDb(), deps);
    expect(result).toEqual({ processed: 3, starred: 2, failed: 1 });
    expect(markTargetStarred).toHaveBeenCalledTimes(2);
    expect(markTargetError).toHaveBeenCalledTimes(1);
    expect(markTargetError).toHaveBeenCalledWith(
      expect.anything(),
      "t2",
      "boom",
    );
  });

  it("marks a missing account token as an error", async () => {
    vi.mocked(listPendingStarTargets).mockResolvedValue([target("t1", "o/r")]);
    const result = await starAidSweep(fakeDb([]), deps);
    expect(result).toEqual({ processed: 1, starred: 0, failed: 1 });
    expect(markTargetError).toHaveBeenCalledWith(
      expect.anything(),
      "t1",
      "account token missing",
    );
    expect(starGitHubRepo).not.toHaveBeenCalled();
  });

  it("returns zeros when there is nothing pending", async () => {
    vi.mocked(listPendingStarTargets).mockResolvedValue([]);
    const result = await starAidSweep(fakeDb(), deps);
    expect(result).toEqual({ processed: 0, starred: 0, failed: 0 });
    expect(starGitHubRepo).not.toHaveBeenCalled();
  });

  it("paces consecutive stars with the injected sleep hook", async () => {
    vi.mocked(listPendingStarTargets).mockResolvedValue([
      target("t1", "owner/repo-a"),
      target("t2", "owner/repo-b"),
    ]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await starAidSweep(fakeDb(), { ...deps, sleep });
    expect(result.starred).toBe(2);
    // Two targets => one pacing gap between them.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed full name as a per-target error", async () => {
    vi.mocked(listPendingStarTargets).mockResolvedValue([
      target("t1", "missing-slash"),
    ]);
    const result = await starAidSweep(fakeDb(), deps);
    expect(result).toEqual({ processed: 1, starred: 0, failed: 1 });
    expect(markTargetError).toHaveBeenCalledWith(
      expect.anything(),
      "t1",
      expect.stringContaining("invalid repository full name"),
    );
    expect(starGitHubRepo).not.toHaveBeenCalled();
  });
});
