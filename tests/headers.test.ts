import { describe, expect, it } from "vitest";
import {
  OAUTH_BETA,
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  extractProxyKey,
  mergeBeta,
} from "../src/proxy/headers.js";

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
  it("replaces the client's credential with our bearer token", () => {
    const headers = buildUpstreamHeaders(
      { "x-api-key": "cpx_local", authorization: "Bearer cpx_local" },
      "oauth-token",
    );
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("never forwards the local proxy key upstream", () => {
    const headers = buildUpstreamHeaders({ "x-api-key": "cpx_secret" }, "token");
    expect([...headers.values()].join(" ")).not.toContain("cpx_secret");
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

  it("always adds the OAuth beta", () => {
    const headers = buildUpstreamHeaders({}, "token");
    expect(headers.get("anthropic-beta")).toBe(OAUTH_BETA);
  });
});

describe("mergeBeta", () => {
  it("keeps the client's betas and prepends ours", () => {
    expect(mergeBeta("computer-use-2024-10-22")).toBe(
      `${OAUTH_BETA},computer-use-2024-10-22`,
    );
  });

  it("does not duplicate ours when the client already sent it", () => {
    expect(mergeBeta(`${OAUTH_BETA},other`)).toBe(`${OAUTH_BETA},other`);
  });

  it("tolerates spacing and empty entries", () => {
    expect(mergeBeta("  a , , b ")).toBe(`${OAUTH_BETA},a,b`);
    expect(mergeBeta("")).toBe(OAUTH_BETA);
    expect(mergeBeta(undefined)).toBe(OAUTH_BETA);
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
