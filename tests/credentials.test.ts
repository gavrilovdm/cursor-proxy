import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../src/auth/credentials.js";
import type { Credentials } from "../src/ports.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cursor-proxy-creds-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  dirs.length = 0;
});

const sample: Credentials = {
  accessToken: "at-secret",
  refreshToken: "rt-secret",
  expiresAt: 1_700_000_000_000,
};

describe("FileCredentialStore", () => {
  it("round-trips credentials", async () => {
    const store = new FileCredentialStore(await tempDir());
    await store.save(sample);
    expect(await store.load()).toEqual(sample);
  });

  it("reports absence rather than throwing on a fresh machine", async () => {
    const store = new FileCredentialStore(join(await tempDir(), "nested"));
    expect(await store.load()).toBeNull();
  });

  it("writes tokens readable only by the owner", async () => {
    const dir = await tempDir();
    await new FileCredentialStore(dir).save(sample);

    const mode = (await stat(join(dir, "credentials.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates the config directory with owner-only permissions", async () => {
    const dir = join(await tempDir(), "home");
    await new FileCredentialStore(dir).save(sample);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("keeps tokens out of config.json", async () => {
    const dir = await tempDir();
    await new FileCredentialStore(dir).save(sample);
    const contents = await readFile(join(dir, "credentials.json"), "utf8");
    expect(contents).toContain("at-secret");
    // The file a user is invited to edit and paste into a bug report.
    await expect(readFile(join(dir, "config.json"), "utf8")).rejects.toThrow();
  });

  it("leaves no temp file behind after an atomic write", async () => {
    const dir = await tempDir();
    await new FileCredentialStore(dir).save(sample);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["credentials.json"]);
  });

  it("treats a corrupt file as no credentials, not a crash", async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "credentials.json"), "{ truncated", "utf8");
    expect(await new FileCredentialStore(dir).load()).toBeNull();
  });

  it("rejects a record missing an access token", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "credentials.json"),
      JSON.stringify({ refreshToken: "rt", expiresAt: 1 }),
      "utf8",
    );
    expect(await new FileCredentialStore(dir).load()).toBeNull();
  });

  it("accepts a record with no refresh token, normalising it to null", async () => {
    const dir = await tempDir();
    const store = new FileCredentialStore(dir);
    await store.save({ ...sample, refreshToken: null });
    expect((await store.load())?.refreshToken).toBeNull();
  });

  it("clear() removes the file", async () => {
    const dir = await tempDir();
    const store = new FileCredentialStore(dir);
    await store.save(sample);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("clear() is safe when nothing is stored", async () => {
    await expect(
      new FileCredentialStore(await tempDir()).clear(),
    ).resolves.toBeUndefined();
  });
});
