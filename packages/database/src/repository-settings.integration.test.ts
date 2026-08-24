import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "./index.js";
import {
  getRepositorySettings,
  getRepositorySettingsFor,
  setRepositorySetting,
} from "./repository-settings.js";

const databaseUrl = process.env.APERTUREPRISM_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("repository settings PostgreSQL integration", () => {
  let client: DatabaseClient;
  let repositoryId = "";
  const owner = `e2e-owner-${Math.random().toString(36).slice(2, 8)}`;
  const name = "settings-fixture";

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("integration database URL is required");
    client = createDatabaseClient(databaseUrl);
    const rows = await client.sql<{ id: string }[]>`
      insert into repositories (github_id, owner, name)
      values (${`e2e-${Math.random().toString(36).slice(2, 10)}`}, ${owner}, ${name})
      returning id`;
    repositoryId = String(rows[0]?.id);
  });

  afterAll(async () => {
    if (!client) return;
    // 级联删除会带走 repository_settings 里的行，正好一并验证外键方向正确。
    await client.sql`delete from repositories where owner = ${owner}`;
    await client.close();
  });

  it("has no overrides before anything is written", async () => {
    const settings = await getRepositorySettings(client.db, repositoryId);
    expect(settings.size).toBe(0);
  });

  it("upserts an override and overwrites it on a second write", async () => {
    await setRepositorySetting(client.db, {
      repositoryId,
      key: "issue_rewrite_title",
      value: "false",
    });
    await setRepositorySetting(client.db, {
      repositoryId,
      key: "issue_rewrite_title",
      value: "true",
    });

    const settings = await getRepositorySettings(client.db, repositoryId);
    expect(settings.get("issue_rewrite_title")).toBe("true");
    // 复合主键必须让第二次写入更新同一行，而不是插入第二行。
    expect(settings.size).toBe(1);
  });

  it("reads only the requested keys", async () => {
    await setRepositorySetting(client.db, {
      repositoryId,
      key: "issue_assignee",
      value: "octocat",
    });

    const subset = await getRepositorySettingsFor(client.db, repositoryId, [
      "issue_assignee",
    ]);
    expect([...subset.keys()]).toEqual(["issue_assignee"]);
    expect(await getRepositorySettingsFor(client.db, repositoryId, [])).toEqual(
      new Map(),
    );
  });

  it("clears an override so the repository follows the global value again", async () => {
    await setRepositorySetting(client.db, {
      repositoryId,
      key: "issue_assignee",
      value: null,
    });

    const settings = await getRepositorySettings(client.db, repositoryId);
    expect(settings.has("issue_assignee")).toBe(false);
    // 清除只影响这一个键。
    expect(settings.has("issue_rewrite_title")).toBe(true);
  });

  it("stores an empty override distinctly from no override", async () => {
    await setRepositorySetting(client.db, {
      repositoryId,
      key: "issue_assignee",
      value: "",
    });

    const settings = await getRepositorySettings(client.db, repositoryId);
    expect(settings.has("issue_assignee")).toBe(true);
    expect(settings.get("issue_assignee")).toBe("");
  });

  it("keeps overrides isolated per repository", async () => {
    const other = await client.sql<{ id: string }[]>`
      insert into repositories (github_id, owner, name)
      values (${`e2e-${Math.random().toString(36).slice(2, 10)}`}, ${owner}, ${"other-fixture"})
      returning id`;
    const otherId = String(other[0]?.id);

    const settings = await getRepositorySettings(client.db, otherId);
    expect(settings.size).toBe(0);
  });
});
