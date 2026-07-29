import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEnvOverrides,
  defaultConfig,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM,
  ENV_VARS,
  FileConfigStore,
  requireClientId,
} from "../src/config.js";
import { ConfigError } from "../src/errors.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cursor-proxy-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("defaultConfig", () => {
  it("ships no OAuth credentials", () => {
    const config = defaultConfig();
    expect(config.oauth.clientId).toBeNull();
    expect(config.oauth.issuer).toBeNull();
    expect(config.oauth.authorizationEndpoint).toBeNull();
    expect(config.oauth.tokenEndpoint).toBeNull();
  });

  it("defaults to a local port and the real upstream", () => {
    expect(defaultConfig().port).toBe(DEFAULT_PORT);
    expect(defaultConfig().upstream).toBe(DEFAULT_UPSTREAM);
  });
});

describe("applyEnvOverrides", () => {
  it("takes the environment value over the file value", () => {
    const config = defaultConfig();
    config.oauth.clientId = "from-file";

    const result = applyEnvOverrides(config, {
      [ENV_VARS.clientId]: "from-env",
    });

    expect(result.oauth.clientId).toBe("from-env");
  });

  it("keeps the file value when the variable is unset", () => {
    const config = defaultConfig();
    config.oauth.clientId = "from-file";

    expect(applyEnvOverrides(config, {}).oauth.clientId).toBe("from-file");
  });

  it("treats an empty variable as unset rather than as a blank value", () => {
    const config = defaultConfig();
    config.oauth.clientId = "from-file";

    const result = applyEnvOverrides(config, { [ENV_VARS.clientId]: "" });

    expect(result.oauth.clientId).toBe("from-file");
  });

  it("never lets the environment supply a proxy key hash", () => {
    const config = defaultConfig();
    config.proxyKeyHash = "abc";

    const result = applyEnvOverrides(config, {
      proxyKeyHash: "injected",
      CURSOR_PROXY_PROXY_KEY_HASH: "injected",
    });

    expect(result.proxyKeyHash).toBe("abc");
  });

  it("parses a numeric port", () => {
    const result = applyEnvOverrides(defaultConfig(), {
      [ENV_VARS.port]: "9000",
    });
    expect(result.port).toBe(9000);
  });

  it("rejects a non-numeric port with actionable guidance", () => {
    expect(() =>
      applyEnvOverrides(defaultConfig(), { [ENV_VARS.port]: "http" }),
    ).toThrow(ConfigError);
  });

  it("rejects an out-of-range port", () => {
    expect(() =>
      applyEnvOverrides(defaultConfig(), { [ENV_VARS.port]: "70000" }),
    ).toThrow(ConfigError);
    expect(() =>
      applyEnvOverrides(defaultConfig(), { [ENV_VARS.port]: "0" }),
    ).toThrow(ConfigError);
  });
});

describe("requireClientId", () => {
  it("returns the configured id", () => {
    const config = defaultConfig();
    config.oauth.clientId = "abc123";
    expect(requireClientId(config)).toBe("abc123");
  });

  it("fails rather than substituting a default when unconfigured", () => {
    expect(() => requireClientId(defaultConfig())).toThrow(ConfigError);
  });

  it("names both the config key and the env var so the user can act", () => {
    try {
      requireClientId(defaultConfig());
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const guidance = (error as ConfigError).toGuidance();
      expect(guidance).toContain("oauth.clientId");
      expect(guidance).toContain(ENV_VARS.clientId);
    }
  });
});

describe("FileConfigStore", () => {
  it("returns defaults when no config file exists yet", async () => {
    const store = new FileConfigStore(join(await makeTempDir(), "nested"), {});
    expect(await store.load()).toEqual(defaultConfig());
  });

  it("round-trips a saved config", async () => {
    const store = new FileConfigStore(await makeTempDir(), {});
    const config = defaultConfig();
    config.oauth.clientId = "saved-id";
    config.proxyKeyHash = "a".repeat(64);

    await store.save(config);

    const loaded = await store.load();
    expect(loaded.oauth.clientId).toBe("saved-id");
    expect(loaded.proxyKeyHash).toBe("a".repeat(64));
  });

  it("creates the directory at 0700 and the file at 0600", async () => {
    const baseDir = join(await makeTempDir(), "store");
    const store = new FileConfigStore(baseDir, {});

    await store.save(defaultConfig());

    expect((await stat(baseDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(baseDir, "config.json"))).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind after an atomic write", async () => {
    const baseDir = await makeTempDir();
    const store = new FileConfigStore(baseDir, {});

    await store.save(defaultConfig());
    await store.save(defaultConfig());

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(baseDir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves an existing key hash when loading a file written by an older version", async () => {
    const baseDir = await makeTempDir();
    const store = new FileConfigStore(baseDir, {});
    const { writeFile } = await import("node:fs/promises");

    // A config missing the newer `upstream` key entirely.
    await writeFile(
      join(baseDir, "config.json"),
      JSON.stringify({ proxyKeyHash: "b".repeat(64), port: 1234 }),
    );

    const loaded = await store.load();
    expect(loaded.proxyKeyHash).toBe("b".repeat(64));
    expect(loaded.upstream).toBe(DEFAULT_UPSTREAM);
    expect(loaded.port).toBe(1234);
  });

  it("applies environment overrides on load", async () => {
    const baseDir = await makeTempDir();
    const store = new FileConfigStore(baseDir, {
      [ENV_VARS.clientId]: "env-id",
    });

    const config = defaultConfig();
    config.oauth.clientId = "file-id";
    await store.save(config);

    expect((await store.load()).oauth.clientId).toBe("env-id");
  });

  it("never writes a plaintext key to disk", async () => {
    const baseDir = await makeTempDir();
    const store = new FileConfigStore(baseDir, {});
    const config = defaultConfig();
    config.proxyKeyHash = "c".repeat(64);

    await store.save(config);

    const raw = await readFile(join(baseDir, "config.json"), "utf8");
    expect(raw).not.toContain("cpx_");
  });
});
