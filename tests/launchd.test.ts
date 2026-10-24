import { describe, expect, it } from "vitest";
import { LABEL, renderPlist } from "../src/service/launchd.js";

describe("launch agent plist", () => {
  const plist = renderPlist({
    node: "/opt/homebrew/bin/node",
    cli: "/Users/me/cursor-proxy/dist/cli.js",
    log: "/Users/me/.cursor-proxy/logs/proxy.log",
  });

  it("runs `start` with absolute paths", () => {
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>/Users/me/cursor-proxy/dist/cli.js</string>");
    expect(plist).toContain("<string>start</string>");
  });

  it("keeps the proxy alive without a restart loop", () => {
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });

  it("gives launchd a PATH that reaches /usr/bin/security", () => {
    expect(plist).toContain("/usr/bin:");
  });

  it("escapes XML in paths", () => {
    expect(renderPlist({ node: "/a&b/node", cli: "/c", log: "/l" })).toContain("/a&amp;b/node");
  });
});
