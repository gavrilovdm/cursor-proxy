import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_VERSION,
  OAUTH_BETA_HEADER,
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  extractProject,
  extractProxyKey,
} from "../src/proxy/headers.js";

describe("extractProject", () => {
  it("reads the project name a client sends", () => {
    expect(extractProject({ "x-cpx-project": "gavrisalive" })).toBe("gavrisalive");
  });

  it("falls back to unknown when the header is missing", () => {
    expect(extractProject({})).toBe("unknown");
  });

  it("refuses values that could forge or break a log line", () => {
    expect(extractProject({ "x-cpx-project": "a b" })).toBe("unknown");
    expect(extractProject({ "x-cpx-project": "evil\nusage model=x" })).toBe("unknown");
    expect(extractProject({ "x-cpx-project": "x".repeat(65) })).toBe("unknown");
  });
});

describe("extractProxyKey", () => {
  it("reads x-api-key, the spelling Anthropic SDKs use", () => {
    expect(extractProxyKey({ "x-api-key": "cpx_abc" })).toBe("cpx_abc");
  });

  it("reads a bearer token, the spelling OpenAI-compatible clients use", () => {
    expect(extractProxyKey({ authorization: "Bearer cpx_abc" })).toBe("cpx_abc");
    expect(extractProxyKey({ authorization: "bearer cpx_abc" })).toBe("cpx_abc");
  });

  it("prefers x-api-key when both are present", () => {
    expect(
      extractProxyKey({ "x-api-key": "cpx_one", authorization: "Bearer cpx_two" }),
    ).toBe("cpx_one");
  });

  it("returns null rather than a partial value for unusable input", () => {
    expect(extractProxyKey({})).toBeNull();
    expect(extractProxyKey({ authorization: "Basic dXNlcjpwYXNz" })).toBeNull();
    expect(extractProxyKey({ authorization: "Bearer" })).toBeNull();
  });
});

describe("buildUpstreamHeaders", () => {
  it("replaces the client's credential with the OAuth bearer token", () => {
    const headers = buildUpstreamHeaders(
      { "x-api-key": "cpx_local", authorization: "Bearer cpx_local" },
      "oauth-access-token",
    );
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer oauth-access-token");
  });

  it("never forwards the local proxy key upstream", () => {
    const headers = buildUpstreamHeaders({ "x-api-key": "cpx_secret" }, "token");
    expect([...headers.values()].join(" ")).not.toContain("cpx_secret");
  });

  it("keeps the project header local", () => {
    const headers = buildUpstreamHeaders({ "x-cpx-project": "gavrisalive" }, "token");
    expect(headers.has("x-cpx-project")).toBe(false);
  });

  it("drops cookies, which no upstream call needs", () => {
    const headers = buildUpstreamHeaders({ cookie: "session=1" }, "token");
    expect(headers.has("cookie")).toBe(false);
  });

  it("drops hop-by-hop headers that describe only the local connection", () => {
    const headers = buildUpstreamHeaders(
      {
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        host: "127.0.0.1:8787",
        "content-length": "42",
        upgrade: "h2c",
      },
      "token",
    );
    for (const name of [
      "connection",
      "transfer-encoding",
      "host",
      "content-length",
      "upgrade",
    ]) {
      expect(headers.has(name)).toBe(false);
    }
  });

  it("passes application headers through untouched", () => {
    const headers = buildUpstreamHeaders(
      { "anthropic-version": "2023-06-01", "content-type": "application/json" },
      "token",
    );
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("supplies anthropic-version when the client omits it", () => {
    const headers = buildUpstreamHeaders({}, "token");
    expect(headers.get("anthropic-version")).toBe(DEFAULT_ANTHROPIC_VERSION);
  });

  it("does not override the client's anthropic-version", () => {
    const headers = buildUpstreamHeaders(
      { "anthropic-version": "2099-01-01" },
      "token",
    );
    expect(headers.get("anthropic-version")).toBe("2099-01-01");
  });

  it("forwards the client's betas untouched", () => {
    const headers = buildUpstreamHeaders(
      { "anthropic-beta": "computer-use-2024-10-22" },
      "token",
    );
    expect(headers.get("anthropic-beta")).toBe(
      `computer-use-2024-10-22,${OAUTH_BETA_HEADER}`,
    );
  });

  it("adds the Anthropic OAuth beta when the client sends none", () => {
    const headers = buildUpstreamHeaders({}, "token");
    expect(headers.get("anthropic-beta")).toBe(OAUTH_BETA_HEADER);
  });

  it("does not duplicate the Anthropic OAuth beta", () => {
    const headers = buildUpstreamHeaders(
      { "anthropic-beta": `${OAUTH_BETA_HEADER},computer-use-2024-10-22` },
      "token",
    );
    expect(headers.get("anthropic-beta")).toBe(
      `${OAUTH_BETA_HEADER},computer-use-2024-10-22`,
    );
  });
});

describe("buildDownstreamHeaders", () => {
  it("drops framing headers that no longer describe the decoded body", () => {
    const result = buildDownstreamHeaders(
      new Headers({
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "content-length": "999",
      }),
    );
    expect(result["content-type"]).toBe("text/event-stream");
    expect(result["content-encoding"]).toBeUndefined();
    expect(result["content-length"]).toBeUndefined();
  });

  it("preserves rate-limit headers clients rely on", () => {
    const result = buildDownstreamHeaders(
      new Headers({ "anthropic-ratelimit-requests-remaining": "42" }),
    );
    expect(result["anthropic-ratelimit-requests-remaining"]).toBe("42");
  });
});
