module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ status: "error", message: "Method not allowed" });
  }
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const safe = {
    status: body.status ?? body.statusCode ?? null,
    body: body.body ?? null,
    sourceMessageId: body.sourceMessageId ?? body.messageId ?? null,
  };
  console.log(`QSTASH_CHECKPOINT_TEST_CALLBACK ${JSON.stringify(safe)}`);
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ status: "recorded" });
};
