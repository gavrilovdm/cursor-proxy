import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyHome, resolveBaseDir, withLegacyEnv } from "../src/home.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "llm-proxy-home-"));
}

describe("withLegacyEnv", () => {
  it("maps CURSOR_PROXY_* to LLM_PROXY_* when the new name is unset", () => {
    expect(withLegacyEnv({ CURSOR_PROXY_PORT: "9000" }).LLM_PROXY_PORT).toBe("9000");
  });

  it("keeps the new name when both are set", () => {
    const env = withLegacyEnv({ CURSOR_PROXY_PORT: "9000", LLM_PROXY_PORT: "9100" });
    expect(env.LLM_PROXY_PORT).toBe("9100");
  });
});

describe("migrateLegacyHome", () => {
  it("moves ~/.cursor-proxy to ~/.llm-proxy and leaves a symlink", () => {
    const home = tempHome();
    mkdirSync(join(home, ".cursor-proxy"));
    writeFileSync(join(home, ".cursor-proxy", "config.json"), "{}");

    expect(migrateLegacyHome(home)).toBe(true);
    expect(readFileSync(join(home, ".llm-proxy", "config.json"), "utf8")).toBe("{}");
    expect(lstatSync(join(home, ".cursor-proxy")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, ".cursor-proxy", "config.json"), "utf8")).toBe("{}");
  });

  it("does nothing when ~/.llm-proxy already exists", () => {
    const home = tempHome();
    mkdirSync(join(home, ".cursor-proxy"));
    mkdirSync(join(home, ".llm-proxy"));

    expect(migrateLegacyHome(home)).toBe(false);
    expect(lstatSync(join(home, ".cursor-proxy")).isDirectory()).toBe(true);
  });

  it("does nothing on a fresh machine", () => {
    const home = tempHome();
    expect(migrateLegacyHome(home)).toBe(false);
    expect(existsSync(join(home, ".llm-proxy"))).toBe(false);
  });
});

describe("resolveBaseDir", () => {
  it("prefers LLM_PROXY_HOME, then CURSOR_PROXY_HOME", () => {
    expect(resolveBaseDir({ LLM_PROXY_HOME: "/a", CURSOR_PROXY_HOME: "/b" })).toBe("/a");
    expect(resolveBaseDir({ CURSOR_PROXY_HOME: "/b" })).toBe("/b");
  });

  it("defaults to ~/.llm-proxy after migrating", () => {
    const home = tempHome();
    mkdirSync(join(home, ".cursor-proxy"));
    expect(resolveBaseDir({}, home)).toBe(join(home, ".llm-proxy"));
    expect(existsSync(join(home, ".llm-proxy"))).toBe(true);
  });
});
