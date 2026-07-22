"use strict";

/**
 * AdvancedIO HTTP function — the fast entry point that sidesteps the ~15s limit.
 *
 *   GET  /            -> submits BOTH jobs (trigger_connection_server and
 *                        trigger_on_demand_server) to MCPPool and returns
 *                        instantly with each job's id + name + statusUrl.
 *   GET  /status?jobId=<id>&name=<serverName> -> that job's status + result.
 *
 * Job scheduling refs the Catalyst Node SDK v2:
 *   catalyst.initialize(req).jobScheduling().job().submitJob(jobMeta)
 *   ...........................................job().getJob(jobId)
 */
const catalyst = require("zcatalyst-sdk-node");
const { IncomingMessage, ServerResponse } = require("http");

// A function jobpool must exist with ALL job functions in TARGETS registered as
// targets (raw + claude variants). Defaults match the "MCPPool" jobpool.
const JOBPOOL_ID = process.env.MCP_JOBPOOL_ID || "54962000000033005";
const JOBPOOL_NAME = process.env.MCP_JOBPOOL_NAME || "MCPPool";

// The job functions to submit. jobPrefix -> job_name prefix (kept short so the
// full name stays within the 1-20 char, alphanumeric/underscore limit). The
// "_claude" variants verify the server by driving its tools with Claude via the
// Anthropic SDK; distinct serverPrefix values keep their cache keys / server
// names from colliding with the raw jobs.
const TARGETS = [
  // {
  //   target: process.env.MCP_JOB_CONNECTION || "trigger_connection_server",
  //   jobPrefix: "viaconn",
  //   serverPrefix: "ServerViaConnection",
  // },
  // {
  //   target: process.env.MCP_JOB_ONDEMAND || "trigger_on_demand_server",
  //   jobPrefix: "ondemand",
  //   serverPrefix: "ServerOnDemand",
  // },
  {
    target:
      process.env.MCP_JOB_CONNECTION_CLAUDE ||
      "trigger_connection_server_claude",
    jobPrefix: "connclaude",
    serverPrefix: "ServerViaConnClaude",
  },
  // {
  //   target:
  //     process.env.MCP_JOB_ONDEMAND_CLAUDE || "trigger_on_demand_server_claude",
  //   jobPrefix: "odclaude",
  //   serverPrefix: "ServerOnDemandClaude",
  // },
];

function makeServerName(prefix = "ServerViaConnection") {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  return `${prefix}-${stamp}`;
}

// Cache key for a run's result — must match trigger_connection_server's derivation.
const cacheKey = (name) =>
  "mcpresult_" + String(name).replace(/[^a-zA-Z0-9]/g, "");

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.write(JSON.stringify(obj));
  res.end();
}

/**
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
module.exports = async (req, res) => {
  try {
    const app = catalyst.initialize(req);
    const job = app.jobScheduling().job();
    const { pathname, searchParams } = new URL(req.url, "http://localhost");

    // --- Fetch a submitted job's status/result ---
    if (pathname.startsWith("/status")) {
      const jobId = searchParams.get("jobId");
      const name = searchParams.get("name");
      if (!jobId)
        return send(res, 400, { ok: false, error: "pass ?jobId=<id>" });
      const details = await job.getJob(jobId);
      // job_status is Submitted/Pending/Running/Successful/Failure. The detailed
      // result (mcpUrl, tool execution outcome) is read from cache, written by
      // the job keyed on the server name (pass ?name= from the submit response).
      let result = null;
      if (name) {
        try {
          const cached = await app.cache().segment().getValue(cacheKey(name));
          result = cached ? JSON.parse(cached) : null;
        } catch {
          result = null; // not cached yet (still running) or key absent
        }
      }
      return send(res, 200, {
        ok: true,
        jobId,
        jobName: details?.job_meta_details?.job_name,
        serverName: name,
        status: details?.job_status,
        result,
        job: details,
      });
    }

    // --- Default: submit BOTH jobs (connection + on-demand) ---
    const ts = Date.now().toString(36); // shared base-36 ms; prefixes keep names unique
    const jobs = [];
    for (const t of TARGETS) {
      const serverName = makeServerName(t.serverPrefix);
      const jobName = `${t.jobPrefix}_${ts}`; // e.g. viaconn_ms / ondemand_ms (<=20 chars)
      console.log(
        `Submitting "${t.target}" as job "${jobName}" to ${JOBPOOL_NAME} (${JOBPOOL_ID}) for "${serverName}"`,
      );
      const submitted = await job.submitJob({
        job_name: jobName,
        jobpool_id: JOBPOOL_ID,
        jobpool_name: JOBPOOL_NAME,
        target_type: "Function",
        target_name: t.target,
        params: { name: serverName },
      });
      const jobId = submitted?.job_id;
      jobs.push({
        target: t.target,
        jobName,
        jobId,
        serverName,
        status: submitted?.job_status,
        statusUrl: jobId
          ? `/status?jobId=${jobId}&name=${encodeURIComponent(serverName)}`
          : undefined,
      });
    }
    return send(res, 202, {
      ok: true,
      message: `Submitted ${jobs.length} jobs (connection + on-demand, raw + claude) — running in the background.`,
      jobs,
    });
  } catch (err) {
    console.error(
      "mcp_status_fetcher error:",
      err && err.stack ? err.stack : err,
    );
    send(res, 500, {
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};
