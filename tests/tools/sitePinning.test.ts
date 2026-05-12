import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveCloudId } from "../../src/tools/wrapHandler.js";
import { defineTool } from "../../src/tools/defs/defineTool.js";
import type { AppConfig } from "../../src/config.js";
import { InsufficientPermissionsError, ToolError } from "../../src/middleware/errorHandler.js";

const tool = defineTool({
  name: "needCloud",
  description: "needs cloudid",
  group: "read_projects",
  authMethod: "oauth",
  needsCloudId: true,
  input: { x: z.string() },
  handler: async () => ({}),
});

const baseConfig = (pinned: string | null = null): AppConfig =>
  ({
    atlassian: { pinnedCloudId: pinned },
  } as unknown as AppConfig);

describe("site pinning", () => {
  it("uses pinned cloudId when set and accessible", () => {
    const id = resolveCloudId(tool, baseConfig("cloud-1"), {
      storedToken: {
        access_token: "x",
        refresh_token: null,
        expires_at: 0,
        account_id: "u",
        name: "n",
        email: null,
        accessible_cloud_ids: ["cloud-1", "cloud-2"],
        primary_cloud_id: "cloud-2",
      },
      apiToken: null,
    });
    expect(id).toBe("cloud-1");
  });

  it("rejects when caller lacks access to the pinned cloudId", () => {
    expect(() =>
      resolveCloudId(tool, baseConfig("cloud-1"), {
        storedToken: {
          access_token: "x",
          refresh_token: null,
          expires_at: 0,
          account_id: "u",
          name: "n",
          email: null,
          accessible_cloud_ids: ["cloud-9"],
          primary_cloud_id: "cloud-9",
        },
        apiToken: null,
      }),
    ).toThrow(InsufficientPermissionsError);
  });

  it("rejects when API token is bound to a different cloudId", () => {
    expect(() =>
      resolveCloudId(tool, baseConfig("cloud-1"), {
        storedToken: {
          access_token: "x",
          refresh_token: null,
          expires_at: 0,
          account_id: "u",
          name: "n",
          email: null,
          accessible_cloud_ids: ["cloud-1"],
          primary_cloud_id: "cloud-1",
        },
        apiToken: {
          account_id: "u",
          email: "a@b.c",
          token: "tok",
          cloud_id: "cloud-9",
          site_url: "x.atlassian.net",
          display_name: "u",
          added_at: 0,
        },
      }),
    ).toThrow(InsufficientPermissionsError);
  });

  it("falls back to primary cloudId when no pin is set", () => {
    const id = resolveCloudId(tool, baseConfig(null), {
      storedToken: {
        access_token: "x",
        refresh_token: null,
        expires_at: 0,
        account_id: "u",
        name: "n",
        email: null,
        accessible_cloud_ids: ["cloud-2"],
        primary_cloud_id: "cloud-2",
      },
      apiToken: null,
    });
    expect(id).toBe("cloud-2");
  });

  it("throws when there is no cloudId from any source", () => {
    expect(() =>
      resolveCloudId(tool, baseConfig(null), {
        storedToken: null,
        apiToken: null,
      }),
    ).toThrow(ToolError);
  });
});
