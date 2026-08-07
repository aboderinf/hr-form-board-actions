const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS = `${GITHUB_ISSUER}/.well-known/jwks`;
const EXPECTED_AUDIENCE = "hr-form-provider-key-transfer";
const EXPECTED_REPOSITORY = "aboderinf/mlb-hr-fair-odds-v1";
const ALLOWED_WORKFLOW = `${EXPECTED_REPOSITORY}/.github/workflows/transfer-provider-key-to-vercel.yml@refs/heads/main`;

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function decodeJson(value) {
  return JSON.parse(decodeBase64Url(value).toString("utf8"));
}

function claimsAllowed(claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return Boolean(
    claims.iss === GITHUB_ISSUER
    && audiences.includes(EXPECTED_AUDIENCE)
    && typeof claims.exp === "number"
    && claims.exp >= nowSeconds - 30
    && (claims.nbf === undefined || claims.nbf <= nowSeconds + 30)
    && claims.repository === EXPECTED_REPOSITORY
    && claims.ref === "refs/heads/main"
    && claims.workflow_ref === ALLOWED_WORKFLOW
    && ["push", "workflow_dispatch"].includes(claims.event_name),
  );
}

async function verifyGitHubActionsToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return false;
  try {
    const header = decodeJson(parts[0]);
    const claims = decodeJson(parts[1]);
    if (header.alg !== "RS256" || !header.kid || !claimsAllowed(claims)) return false;
    const response = await fetch(GITHUB_JWKS, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return false;
    const payload = await response.json();
    const jwk = (payload.keys || []).find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(parts[2]),
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
    );
  } catch {
    return false;
  }
}

module.exports = { claimsAllowed, verifyGitHubActionsToken };
