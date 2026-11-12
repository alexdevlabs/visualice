import { describe, expect, it } from "vitest";
import { isGraphqlRead, siteOf, writeOf, writeRules } from "../src/crawl/writes";
import { TargetSchema } from "../src/shared/manifest-schema";
import { AuthoredFileSchema } from "../src/crawl/author";
import { ConfigSchema } from "../src/shared/config";

const req = (method: string, url: string, postData: string | null = null, type = "fetch") => ({
  method: () => method,
  url: () => url,
  resourceType: () => type,
  postData: () => postData,
});

describe("writes to the server", () => {
  const rules = writeRules("https://app.example.com/chat", ["/ingest/**"]);

  it("takes a site and its subdomains as one", () => {
    expect(siteOf("api.example.com")).toBe("example.com");
    expect(siteOf("localhost")).toBe("localhost");
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
  });

  it("counts a POST, PUT, PATCH or DELETE to the site", () => {
    expect(writeOf(req("POST", "https://api.example.com/jobs?x=1"), rules)).toBe("POST /jobs");
    expect(writeOf(req("DELETE", "https://app.example.com/a/1"), rules)).toBe("DELETE /a/1");
    expect(writeOf(req("patch", "https://app.example.com/a"), rules)).toBe("PATCH /a");
  });

  it("leaves out reads, other sites, beacons, sockets and allowed paths", () => {
    expect(writeOf(req("GET", "https://app.example.com/jobs"), rules)).toBeUndefined();
    expect(writeOf(req("POST", "https://analytics.test/collect"), rules)).toBeUndefined();
    expect(writeOf(req("POST", "https://app.example.com/b", null, "ping"), rules)).toBeUndefined();
    expect(writeOf(req("POST", "https://app.example.com/ingest/e"), rules)).toBeUndefined();
  });

  it("tells a GraphQL query from a mutation", () => {
    const q = JSON.stringify({ query: "query Me { me { id } }" });
    const short = JSON.stringify({ query: "{ me { id } }" });
    const m = JSON.stringify({ query: "fragment F on X { id }\nmutation Go { go { ...F } }" });
    const batch = JSON.stringify([{ query: "query A { a }" }, { query: "mutation B { b }" }]);
    expect(isGraphqlRead(q)).toBe(true);
    expect(isGraphqlRead(short)).toBe(true);
    expect(isGraphqlRead(m)).toBe(false);
    expect(isGraphqlRead(batch)).toBe(false);
    expect(isGraphqlRead('{"id":"abc"}')).toBe(false);
    expect(isGraphqlRead("not json")).toBe(false);
    expect(writeOf(req("POST", "https://app.example.com/graphql", q), rules)).toBeUndefined();
    expect(writeOf(req("POST", "https://app.example.com/graphql", m), rules)).toBe("POST /graphql");
  });
});

describe("targets", () => {
  it("refuses a key it doesn't know, and a target with nothing to find", () => {
    expect(TargetSchema.safeParse({ css: ".x" }).success).toBe(false);
    expect(TargetSchema.safeParse({ selector: ".x", css: ".x" }).success).toBe(false);
    expect(TargetSchema.safeParse({ exact: true }).success).toBe(false);
    expect(TargetSchema.safeParse({ role: "button", name: "Previous reply" }).success).toBe(true);
  });

  it("checks the targets in an explorer's file and in the login steps", () => {
    const file = {
      $schema: "https://unpkg.com/visualice/explore.schema.json",
      states: [
        {
          id: "replies",
          kind: "modal",
          label: "Replies",
          page: "/chat",
          recipe: [{ action: "click", target: { css: "button.prev" } }],
        },
      ],
    };
    expect(AuthoredFileSchema.safeParse(file).success).toBe(false);
    const login = (target: Record<string, unknown>) =>
      ConfigSchema.safeParse({
        auth: { login: { steps: [{ action: "click", target }] } },
      }).success;
    expect(login({ css: "#go" })).toBe(false);
    expect(login({ selector: "#go" })).toBe(true);
  });
});
