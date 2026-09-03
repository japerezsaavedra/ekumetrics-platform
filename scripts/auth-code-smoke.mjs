import { createHash, randomBytes } from "node:crypto";

const baseUrl = (
  process.env.KEYCLOAK_TEST_URL || "http://127.0.0.1:18080"
).replace(/\/$/, "");
const realm = process.env.KEYCLOAK_TEST_REALM || "ekumetrics";
const clientId = process.env.KEYCLOAK_TEST_CLIENT || "portal-web";
const username = process.env.KEYCLOAK_TEST_USER || "operator";
const password = process.env.KEYCLOAK_TEST_PASSWORD || "ekumetrics-local";
const expectedTenant = process.env.KEYCLOAK_TEST_EXPECTED_TENANT || "default";
const expectedRole = process.env.KEYCLOAK_TEST_EXPECTED_ROLE || "operator";
const requireHttps = process.env.KEYCLOAK_TEST_REQUIRE_HTTPS === "true";
const redirectUri =
  process.env.KEYCLOAK_TEST_REDIRECT || "http://localhost:3000/v1/auth/callback";
const oidc = `${baseUrl}/realms/${realm}/protocol/openid-connect`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (requireHttps) {
  assert(new URL(baseUrl).protocol === "https:", "La prueba productiva exige Keycloak sobre HTTPS.");
  assert(new URL(redirectUri).protocol === "https:", "La prueba productiva exige callback sobre HTTPS.");
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"');
}

function formAction(html) {
  const form = html.match(/<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/i);
  assert(form?.[1], "Keycloak no entregó el formulario de acceso esperado.");
  return decodeHtml(form[1]);
}

function cookies(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function payload(token) {
  const segment = token.split(".")[1];
  assert(segment, "Keycloak entregó un JWT inválido.");
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

async function json(response, context) {
  const body = await response.json().catch(() => ({}));
  assert(
    response.ok,
    `${context}: HTTP ${response.status} ${JSON.stringify(body)}`,
  );
  return body;
}

const verifier = randomBytes(64).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("base64url");
const nonce = randomBytes(16).toString("base64url");
const authorization = new URL(`${oidc}/auth`);
authorization.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "openid",
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

const loginPage = await fetch(authorization, { redirect: "manual" });
assert(
  loginPage.status === 200,
  `No se abrió el login de Keycloak: HTTP ${loginPage.status}.`,
);
const loginCookies = cookies(loginPage);
const loginAction = formAction(await loginPage.text());
const authenticated = await fetch(loginAction, {
  method: "POST",
  redirect: "manual",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: loginCookies,
  },
  body: new URLSearchParams({ username, password, credentialId: "" }),
});
assert(
  authenticated.status >= 300 && authenticated.status < 400,
  "Keycloak rechazó el acceso.",
);
const callback = new URL(authenticated.headers.get("location") || "");
assert(
  callback.origin + callback.pathname === redirectUri,
  "Keycloak devolvió un redirect inesperado.",
);
assert(
  callback.searchParams.get("state") === state,
  "El state OIDC no coincide.",
);
const code = callback.searchParams.get("code");
assert(code, "Keycloak no devolvió authorization code.");

const tokens = await json(
  await fetch(`${oidc}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  }),
  "Intercambio PKCE",
);
assert(
  tokens.access_token && tokens.refresh_token && tokens.id_token,
  "Faltan tokens OIDC.",
);
const claims = payload(tokens.access_token);
assert(claims.typ === "Bearer", "Keycloak no entregó un access token Bearer.");
assert(
  claims.aud === clientId || claims.aud?.includes(clientId),
  "Audience incorrecta.",
);
assert(claims.tenant === expectedTenant, "Tenant incorrecto en el access token.");
assert(
  claims.realm_access?.roles?.includes(expectedRole),
  `Rol ${expectedRole} ausente.`,
);

const refreshed = await json(
  await fetch(`${oidc}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    }),
  }),
  "Renovación de sesión",
);
assert(
  refreshed.access_token && refreshed.refresh_token,
  "Keycloak no renovó la sesión.",
);

const logout = await fetch(`${oidc}/logout`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshed.refresh_token,
  }),
});
assert(logout.ok, `Logout rechazado: HTTP ${logout.status}.`);

const afterLogout = await fetch(`${oidc}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshed.refresh_token,
  }),
});
assert(
  afterLogout.status === 400,
  "El refresh token siguió activo después del logout.",
);

console.log(
  "OIDC real correcto: Authorization Code + PKCE, refresh y revocación de sesión.",
);
