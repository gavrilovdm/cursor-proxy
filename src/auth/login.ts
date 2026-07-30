import type {
  Browser,
  Clock,
  Config,
  CredentialStore,
  Credentials,
  HttpClient,
  Logger,
  Prompt,
} from "../ports.js";
import { requireClientId } from "../config.js";
import { buildAuthorizationUrl, exchangeCode, resolveEndpoints } from "./oauth.js";
import { generatePkcePair, generateState } from "./pkce.js";
import { startLoopbackReceiver } from "./loopback.js";

export interface LoginDeps {
  http: HttpClient;
  clock: Clock;
  browser: Browser;
  prompt?: Prompt;
  logger: Logger;
  credentials: CredentialStore;
}

export interface LoginOptions {
  timeoutMs?: number;
  /** Fixed loopback port, for providers that require a pre-registered redirect URI. */
  port?: number;
}

/**
 * Run the full authorization-code + PKCE login and persist the result.
 *
 * The loopback receiver is started *before* the browser opens: the redirect URI
 * has to be in the authorization URL, and its port is only known once the OS
 * has assigned one.
 */
export async function login(
  config: Config,
  deps: LoginDeps,
  options: LoginOptions = {},
): Promise<Credentials> {
  const clientId = requireClientId(config);
  const endpoints = await resolveEndpoints(config.oauth, deps.http);

  const pkce = generatePkcePair();
  const state = generateState();

  const receiver = config.oauth.redirectUri
    ? null
    : await startLoopbackReceiver({
        expectedState: state,
        ...(options.port !== undefined ? { port: options.port } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
  const redirectUri = config.oauth.redirectUri ?? receiver!.redirectUri;

  try {
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId,
      redirectUri,
      scope: config.oauth.scope,
      state,
      codeChallenge: pkce.challenge,
      extraParams: config.oauth.authParams,
    });

    deps.logger.info("Opening your browser to sign in…");
    deps.logger.info(`If it does not open, visit:\n  ${authorizationUrl}`);
    try {
      await deps.browser.open(authorizationUrl);
    } catch {
      // Headless machines and locked-down desktops have no opener. The URL was
      // already printed, so this is recoverable — do not abort the login.
      deps.logger.warn("Could not open a browser automatically.");
    }

    const callback = receiver
      ? { code: await receiver.waitForCode(), state }
      : parseManualAuthorizationResponse(
          await readManualAuthorizationResponse(deps),
          state,
        );

    const credentials = await exchangeCode(
      {
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId,
        clientSecret: config.oauth.clientSecret,
        code: callback.code,
        state: callback.state,
        codeVerifier: pkce.verifier,
        redirectUri,
        tokenRequestFormat: config.oauth.tokenRequestFormat,
      },
      deps.http,
      deps.clock,
    );

    await deps.credentials.save(credentials);
    return credentials;
  } finally {
    await receiver?.close();
  }
}

/** Forget stored tokens. Local only — it does not revoke server-side. */
export async function logout(store: CredentialStore): Promise<void> {
  await store.clear();
}

async function readManualAuthorizationResponse(deps: LoginDeps): Promise<string> {
  if (!deps.prompt) {
    throw new Error("Manual OAuth callback requires an interactive prompt.");
  }
  deps.logger.info(
    "After authorizing, paste the full callback URL or the displayed code#state value.",
  );
  return deps.prompt.readLine("Authorization response: ");
}

function parseManualAuthorizationResponse(
  raw: string,
  expectedState: string,
): { code: string; state: string } {
  const trimmed = raw.trim();
  let code: string | null = null;
  let state: string | null = null;

  try {
    const url = new URL(trimmed);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
    if (!code && url.hash.includes("#")) {
      const fragment = url.hash.slice(1);
      const split = splitCodeAndState(fragment);
      code = split.code;
      state = split.state;
    }
  } catch {
    const split = splitCodeAndState(trimmed);
    code = split.code;
    state = split.state;
  }

  if (!code || !state) {
    throw new Error(
      "Authorization response must include both code and state. Paste the displayed code#state value.",
    );
  }
  if (state !== expectedState) {
    throw new Error("Authorization response carried an unexpected state.");
  }
  return { code, state };
}

function splitCodeAndState(value: string): { code: string | null; state: string | null } {
  const index = value.lastIndexOf("#");
  if (index === -1) return { code: value || null, state: null };
  return {
    code: value.slice(0, index) || null,
    state: value.slice(index + 1) || null,
  };
}
