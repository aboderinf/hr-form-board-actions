const { verifyGitHubActionsToken } = require("../lib/github-oidc-transfer");
const { redisWriteWithRetry } = (() => {
  const runtime = require("../lib/checkpoint-runtime");
  async function write(command, attempts = 3) {
    let last;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await runtime.redisCommand(command);
      } catch (error) {
        last = error;
        if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)));
      }
    }
    throw last;
  }
  return { redisWriteWithRetry: write };
})();

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const header = String(request.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !(await verifyGitHubActionsToken(token))) {
    return response.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const apiKey = String(request.body?.apiKey || "").trim();
  if (apiKey.length < 16 || apiKey.length > 500) {
    return response.status(400).json({ status: "error", message: "Invalid provider key" });
  }

  try {
    await redisWriteWithRetry(["SET", "mlbhr:config:sportsgameodds-api-key", apiKey]);
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({ status: "stored", secret: "SPORTSGAMEODDS_API_KEY" });
  } catch (error) {
    return response.status(503).json({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
