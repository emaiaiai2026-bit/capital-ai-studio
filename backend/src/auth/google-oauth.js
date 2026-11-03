const encoder = new TextEncoder();
const COOKIE_NAME = "__Host-capital_session";
const STATE_COOKIE = "__Host-capital_oauth";
const SESSION_SECONDS = 60 * 60 * 24 * 7;

function b64url(bytes) {
  let binary = "";
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return btoa(binary).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}
function decodeB64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return b64url(value);
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(value, secret) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(value));
  return b64url(new Uint8Array(signature));
}
async function verify(value, signature, secret) {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), decodeB64url(signature), encoder.encode(value));
  } catch { return false; }
}
function cookieValue(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}
function setCookie(name, value, maxAge, httpOnly = true) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}`;
}
function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; Secure; SameSite=Lax; HttpOnly`;
}
function redirect(url, cookies = []) {
  const headers = new Headers({ Location: url, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function getRedirectUri(env) {
  if (!env.APP_ORIGIN) throw new Error("APP_ORIGIN_NOT_CONFIGURED");
  const origin = new URL(env.APP_ORIGIN);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") throw new Error("APP_ORIGIN_MUST_USE_HTTPS");
  return new URL("/auth/google/callback", origin).toString();
}
async function parseSignedCookie(raw, secret) {
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const value = raw.slice(0, dot);
  if (!(await verify(value, raw.slice(dot + 1), secret))) return null;
  try { return JSON.parse(new TextDecoder().decode(decodeB64url(value))); } catch { return null; }
}
async function makeSignedCookie(payload, secret) {
  const value = b64url(encoder.encode(JSON.stringify(payload)));
  return value + "." + await sign(value, secret);
}
async function verifyGoogleIdToken(token, clientId, expectedNonce) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("INVALID_ID_TOKEN");
  const header = JSON.parse(new TextDecoder().decode(decodeB64url(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(decodeB64url(parts[1])));
  if (header.alg !== "RS256" || !header.kid) throw new Error("INVALID_ID_TOKEN_ALGORITHM");
  const discoveryResponse = await fetch("https://accounts.google.com/.well-known/openid-configuration");
  if (!discoveryResponse.ok) throw new Error("GOOGLE_DISCOVERY_FAILED");
  const discovery = await discoveryResponse.json();
  const keysResponse = await fetch(discovery.jwks_uri);
  if (!keysResponse.ok) throw new Error("GOOGLE_KEYS_FAILED");
  const keySet = await keysResponse.json();
  const jwk = keySet.keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.use === "sig");
  if (!jwk) throw new Error("GOOGLE_SIGNING_KEY_NOT_FOUND");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeB64url(parts[2]), encoder.encode(parts[0] + "." + parts[1]));
  const now = Math.floor(Date.now() / 1000);
  if (!valid || !["https://accounts.google.com", "accounts.google.com"].includes(claims.iss) ||
      claims.aud !== clientId || !claims.sub || !claims.exp || claims.exp <= now ||
      claims.iat > now + 60 || claims.nonce !== expectedNonce || claims.email_verified !== true) {
    throw new Error("GOOGLE_ID_TOKEN_REJECTED");
  }
  return { sub: claims.sub, email: claims.email, name: claims.name || "", picture: claims.picture || "" };
}

export async function handleGoogleAuth(request, env, pathname) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET || !env.APP_ORIGIN) {
    return json({ error: { code: "AUTH_NOT_CONFIGURED" } }, 503);
  }
  const redirectUri = getRedirectUri(env);
  if (request.method === "GET" && pathname === "/auth/google/start") {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
    const payload = { state, nonce, verifier, exp: Date.now() + 10 * 60 * 1000 };
    const signed = await makeSignedCookie(payload, env.SESSION_SECRET);
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code",
      scope: "openid email profile", state, nonce, code_challenge: challenge,
      code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    return redirect(target.toString(), [setCookie(STATE_COOKIE, signed, 600)]);
  }

  if (request.method === "GET" && pathname === "/auth/google/callback") {
    const url = new URL(request.url);
    const state = await parseSignedCookie(cookieValue(request, STATE_COOKIE), env.SESSION_SECRET);
    const code = url.searchParams.get("code");
    if (!state || state.exp < Date.now() || !code || url.searchParams.get("state") !== state.state) {
      return json({ error: { code: "OAUTH_STATE_INVALID" } }, 400);
    }
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: state.verifier,
      }),
    });
    if (!tokenResponse.ok) return json({ error: { code: "GOOGLE_TOKEN_EXCHANGE_FAILED" } }, 401);
    const tokens = await tokenResponse.json();
    if (!tokens.id_token) return json({ error: { code: "GOOGLE_ID_TOKEN_MISSING" } }, 401);
    const user = await verifyGoogleIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID, state.nonce);
    const now = Math.floor(Date.now() / 1000);
    const session = await makeSignedCookie({ sub: user.sub, email: user.email, name: user.name, picture: user.picture, iat: now, exp: now + SESSION_SECONDS }, env.SESSION_SECRET);
    return redirect(new URL("/", env.APP_ORIGIN).toString(), [
      setCookie(COOKIE_NAME, session, SESSION_SECONDS),
      clearCookie(STATE_COOKIE),
    ]);
  }
  return null;
}

export async function getSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const session = await parseSignedCookie(cookieValue(request, COOKIE_NAME), env.SESSION_SECRET);
  if (!session || !session.sub || !session.exp || session.exp <= Math.floor(Date.now() / 1000)) return null;
  return { sub: session.sub, email: session.email, name: session.name, picture: session.picture };
}

export function logoutResponse() {
  return redirect("/", [clearCookie(COOKIE_NAME), clearCookie(STATE_COOKIE)]);
}
