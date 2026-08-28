const captureCheckpointHandler = require("./capture-checkpoint");

// Dedicated QStash destination for the daily Top 100 build. The shared
// capture-checkpoint handler owns the implementation so there is only one
// Top 100 code path; this adapter makes /api/top100-refresh a real endpoint.
module.exports = async function handler(request, response) {
  request.query = {
    ...(request.query || {}),
    action: "top100-refresh",
  };
  return captureCheckpointHandler(request, response);
};
