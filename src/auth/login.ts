import type {
  Browser,
  Clock,
  Config,
  CredentialStore,
  Credentials,
  HttpClient,
  Logger,
} from "../ports.js";
import { requireClientId } from "../config.js";
import { buildAuthorizationUrl, exchangeCode, resolveEndpoints } from "./oauth.js";
import { generatePkcePair, generateState } from "./pkce.js";
import { startLoopbackReceiver } from "./loopback.js";

export interface LoginDeps {
  http: HttpClient;
  clock: Clock;
  browser: Browser;
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

  const receiver = await startLoopbackReceiver({
    expectedState: state,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  try {
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId,
      redirectUri: receiver.redirectUri,
      scope: config.oauth.scope,
      state,
      codeChallenge: pkce.challenge,
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

    const code = await receiver.waitForCode();

    const credentials = await exchangeCode(
      {
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId,
        code,
        codeVerifier: pkce.verifier,
        redirectUri: receiver.redirectUri,
      },
      deps.http,
      deps.clock,
    );

    await deps.credentials.save(credentials);
    return credentials;
  } finally {
    await receiver.close();
  }
}

/** Forget stored tokens. Local only — it does not revoke server-side. */
export async function logout(store: CredentialStore): Promise<void> {
  await store.clear();
}
