import { afterEach, describe, expect, it } from "vitest";
import {
  startLoopbackReceiver,
  type LoopbackReceiver,
} from "../src/auth/loopback.js";

let receiver: LoopbackReceiver | null = null;

afterEach(async () => {
  await receiver?.close();
  receiver = null;
});

async function open(expectedState = "state-abc", timeoutMs = 5_000) {
  receiver = await startLoopbackReceiver({ expectedState, timeoutMs });
  return receiver;
}

/** Hit the callback the way a browser would, ignoring the HTML we send back. */
async function callback(base: string, query: Record<string, string>) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url);
  await response.text();
  return response;
}

describe("startLoopbackReceiver", () => {
  it("binds loopback on an OS-assigned port", async () => {
    const { redirectUri } = await open();
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("delivers the code from a matching callback", async () => {
    const { redirectUri, waitForCode } = await open();
    const pending = waitForCode();

    const response = await callback(redirectUri, {
      code: "auth-code",
      state: "state-abc",
    });

    expect(response.status).toBe(200);
    await expect(pending).resolves.toBe("auth-code");
  });

  it("rejects a callback carrying the wrong state", async () => {
    const { redirectUri, waitForCode } = await open();
    // The assertion is attached before the callback fires: waitForCode rejects
    // during `callback()`, and a handler attached afterwards would arrive late.
    const rejected = expect(waitForCode()).rejects.toMatchObject({
      code: "state_mismatch",
    });

    // A page the user has open could fire this to bind the proxy to someone
    // else's account.
    const response = await callback(redirectUri, {
      code: "attacker-code",
      state: "wrong-state",
    });

    expect(response.status).toBe(400);
    await rejected;
  });

  it("rejects a callback with no state at all", async () => {
    const { redirectUri, waitForCode } = await open();
    const rejected = expect(waitForCode()).rejects.toMatchObject({
      code: "state_mismatch",
    });

    await callback(redirectUri, { code: "auth-code" });
    await rejected;
  });

  it("surfaces the provider's own error", async () => {
    const { redirectUri, waitForCode } = await open();
    const rejected = expect(waitForCode()).rejects.toMatchObject({
      code: "access_denied",
      message: expect.stringContaining("user refused"),
    });

    await callback(redirectUri, {
      error: "access_denied",
      error_description: "user refused",
      state: "state-abc",
    });

    await rejected;
  });

  it("rejects a callback with neither code nor error", async () => {
    const { redirectUri, waitForCode } = await open();
    const rejected = expect(waitForCode()).rejects.toMatchObject({
      code: "missing_code",
    });

    await callback(redirectUri, { state: "state-abc" });
    await rejected;
  });

  it("ignores requests to other paths, such as favicon fetches", async () => {
    const { redirectUri, waitForCode } = await open();
    const pending = waitForCode();

    const base = new URL(redirectUri);
    const stray = await fetch(new URL("/favicon.ico", base));
    await stray.text();
    expect(stray.status).toBe(404);

    await callback(redirectUri, { code: "auth-code", state: "state-abc" });
    await expect(pending).resolves.toBe("auth-code");
  });

  it("gives up rather than hanging forever", async () => {
    const { waitForCode } = await open("state-abc", 50);
    await expect(waitForCode()).rejects.toMatchObject({ code: "login_timeout" });
  });

  it("releases the port on close", async () => {
    const first = await open();
    const port = Number(new URL(first.redirectUri).port);
    await first.close();
    receiver = null;

    const reused = await startLoopbackReceiver({
      expectedState: "s",
      port,
      timeoutMs: 1_000,
    });
    receiver = reused;
    expect(new URL(reused.redirectUri).port).toBe(String(port));
  });
});
