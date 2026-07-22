"use strict";

/**
 * Catalyst Job Function — runs the full "Authorization on Demand" MCP flow.
 *
 * Like trigger_connection_server, but the server is LEFT on "Authorization on
 * Demand" (no "Authorize via Connection" switch). Executing the tool therefore
 * requires the MCP client to complete OAuth 2.1, which this job does end to end:
 *   login -> create server -> add "Catalyst by Zoho LZ" tool (Organization)
 *   -> grab MCP URL -> OAuth client flow (DCR -> PKCE -> Allow -> consent
 *      checkbox + Accept -> capture code -> token) -> tools/call with Bearer.
 *
 * Remote browser via Catalyst SmartBrowz (CDP), so playwright-core suffices.
 *
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
const { chromium } = require("playwright-core");
const catalyst = require("zcatalyst-sdk-node");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");

const BASE_URL = "https://mcp.localzoho.com/";
const EMAIL = process.env.MCP_EMAIL || "yashwanth.v+mcp@zohotest.com";
const PASSWORD = process.env.MCP_PASSWORD || "12345@Catalyst";
const WEB_URL =
  process.env.SMARTBROWZ_WS ||
  "ws://browser360.localcatalystserverless.app/hub?project-id=21961000000017052&grid-id=2745000002385011&api-key=a3bfed13e60531de93645960be18ff3557473ced307b56c872e5ab62a5f964df1148285f95b11ce2dc0e15b428546989494adb3749519fad8d90acaa3cc19c79";
// Loopback redirect used by the OAuth client. It never actually loads (connection
// refused); we read the ?code= off the redirect request URL.
const REDIRECT_URI = "http://localhost:53682/callback";
const REDIRECT_ORIGIN = "http://localhost:53682";

const SHOTS_DIR = path.join(os.tmpdir(), "screenshots");
const AUTH_FILE = path.join(os.tmpdir(), "auth.json");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const cacheKey = (name) => "mcpresult_" + String(name).replace(/[^a-zA-Z0-9]/g, "");
const maskKey = (url) => (url || "").replace(/\/mcp\/[^/]+\//, "/mcp/****/");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makeServerName(prefix = "ServerOnDemand") {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  return `${prefix}-${stamp}`;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true }).catch(() => {});
}

async function login(page) {
  console.log(`Navigating to ${BASE_URL}`);
  // SmartBrowz nodes can be slow to warm up — use a long timeout, resolve on
  // "commit" (as soon as the navigation starts), and retry once.
  let navigated = false;
  for (let attempt = 1; attempt <= 2 && !navigated; attempt++) {
    try {
      await page.goto(BASE_URL, { waitUntil: "commit", timeout: 90000 });
      navigated = true;
    } catch (e) {
      console.log(`goto attempt ${attempt} failed: ${(e.message || "").split("\n")[0]}`);
    }
  }
  if (!navigated) throw new Error(`could not load ${BASE_URL} (SmartBrowz navigation timeout)`);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  if (!/accounts\.localzoho\.com/.test(page.url())) {
    console.log("Already authenticated (cached session).");
    return;
  }
  console.log("Signing in...");
  const emailField = page.locator("#login_id, input[name='LOGIN_ID'], input[type='email']").first();
  // The accounts page sometimes opens on the "Smart Sign-in via OneAuth" (QR)
  // screen, where the email field is hidden. Switch to email/password sign-in.
  if (!(await emailField.isVisible().catch(() => false))) {
    console.log("Smart Sign-in screen detected — switching to email sign-in...");
    await page.getByText(/sign in via email/i).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await emailField.waitFor({ state: "visible", timeout: 30000 });
  await emailField.fill(EMAIL);
  await page.locator("#nextbtn, #nextbtn_myzoho, button:has-text('Next')").first().click();
  const pwField = page.locator("#password, input[name='PASSWORD'], input[type='password']").first();
  await pwField.waitFor({ state: "visible" });
  await pwField.fill(PASSWORD);
  await page.locator("#nextbtn, button:has-text('Sign in'), #signin_submit").first().click();
  await page.waitForFunction(() => window.location.hostname === "mcp.localzoho.com", undefined, { timeout: 90000 });
}

/** On the server-list page: open the create modal, name it, submit. Returns the URL. */
async function createServerViaModal(page, serverName) {
  console.log(`Creating MCP server "${serverName}"...`);
  const createBtn = page
    .getByText(/create mcp server/i)
    .or(page.getByRole("button", { name: /create( mcp)? server/i }))
    .first();
  const nameField = page.getByPlaceholder("Enter server name");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await createBtn.waitFor({ state: "visible", timeout: 20000 });
    await createBtn.click();
    try {
      await nameField.waitFor({ state: "visible", timeout: 8000 });
      break;
    } catch {
      console.log(`Modal didn't open (attempt ${attempt}); retrying...`);
    }
  }
  // lyte-input commits on blur/change, not on keystroke — type, then commit.
  await nameField.waitFor({ state: "visible", timeout: 20000 });
  await nameField.click();
  await nameField.pressSequentially(serverName, { delay: 40 });
  await nameField.dispatchEvent("change");
  await nameField.evaluate((el) => el.blur());
  await page.waitForTimeout(400);
  const submitBtn = page.locator(".lytePrimaryBtn").filter({ hasText: /create/i }).last();
  await submitBtn.click({ timeout: 10000 }).catch(async () => {
    await page.getByRole("button", { name: /^create$/i }).last().click({ force: true });
  });
  await Promise.race([
    nameField.waitFor({ state: "detached", timeout: 30000 }).catch(() => {}),
    page.getByText(serverName, { exact: false }).first().waitFor({ timeout: 30000 }).catch(() => {}),
  ]);
  await page.waitForTimeout(2500);
  await shot(page, `created-${serverName}`);
  console.log(`Server created. Now at: ${page.url()}`);
  return page.url();
}

/** On the new server's Tools page: Add Tools -> search "catalyst" -> pick it -> Organization -> Add Now. */
async function addCatalystTool(page) {
  console.log(`Adding "Catalyst by Zoho LZ" (Organization)...`);
  const addBtn = page.getByRole("button", { name: /add tools/i }).first();
  await addBtn.waitFor({ state: "visible", timeout: 20000 });
  await addBtn.click();
  await page.waitForTimeout(2000);

  const search = page.getByPlaceholder(/browse products|search/i).last();
  await search.waitFor({ state: "visible", timeout: 15000 });
  await search.click();
  await search.pressSequentially("catalyst", { delay: 60 });
  await search.dispatchEvent("change");
  await page.waitForTimeout(2000);

  const item = page.getByText(/catalyst by zoho\s*lz/i).first();
  await item.waitFor({ state: "visible", timeout: 15000 });
  await item.click();
  await page.waitForTimeout(2000);

  await page.getByRole("button", { name: /add now/i }).first().waitFor({ state: "visible", timeout: 15000 });
  const orgCard = page
    .locator("div")
    .filter({ has: page.getByText("Organization", { exact: true }) })
    .last();
  await orgCard
    .locator("input[type=checkbox], lyte-checkbox, [class*=heckbox]")
    .first()
    .click({ timeout: 10000 })
    .catch(async () => {
      await page.getByText("Organization", { exact: true }).first().click();
    });
  await page.waitForTimeout(1000);

  // Also select the specific "List All Projects" tool from the Projects group.
  // Clicking the "Projects" group card drills into a modal listing that group's
  // individual tools (Delete Project / Get Project By Id / List All Projects),
  // each a row = checkbox + name + description. Tick only that one; selections
  // persist so a single "Add Now" adds it alongside Organization.
  console.log(`Selecting "List All Projects" from the Projects group...`);
  await page.getByText("Projects", { exact: true }).first().click();
  await page.waitForTimeout(2500); // let the Projects drill-in tools modal render

  // Tick "List All Projects" by matching the checkbox on the SAME VISUAL ROW as
  // the tool name — layout-agnostic (works whether the row wraps the checkbox or
  // a column grid keeps them as siblings). Mark that checkbox in the DOM, then
  // click it with a real Playwright click. The PROBE log shows what was found.
  const projProbe = await page
    .evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const leaf = [...document.querySelectorAll("*")].find(
        (el) =>
          el.children.length === 0 &&
          /list all projects/i.test(el.textContent || ""),
      );
      if (!leaf) return { ok: false, reason: "name-not-found" };
      const lr = leaf.getBoundingClientRect();
      const boxes = [
        ...document.querySelectorAll(
          "input[type=checkbox], lyte-checkbox, [class*=heckbox]",
        ),
      ]
        .map((cb) => ({ cb, r: cb.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0);
      if (!boxes.length) return { ok: false, reason: "no-checkboxes" };
      boxes.sort(
        (a, b) =>
          Math.abs(a.r.top + a.r.height / 2 - (lr.top + lr.height / 2)) -
          Math.abs(b.r.top + b.r.height / 2 - (lr.top + lr.height / 2)),
      );
      boxes[0].cb.setAttribute("data-auto-target", "lap");
      return {
        ok: true,
        name: norm(leaf.textContent).slice(0, 40),
        cbTag: boxes[0].cb.tagName.toLowerCase(),
        rowDy: Math.round(boxes[0].r.top - lr.top),
      };
    })
    .catch((e) => ({
      ok: false,
      reason: "probe-threw:" + (e.message || "").slice(0, 60),
    }));
  console.log("PROBE list-all-projects:", JSON.stringify(projProbe));

  let projTicked = false;
  if (projProbe.ok) {
    projTicked = await page
      .locator('[data-auto-target="lap"]')
      .click({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!projTicked)
    console.log('WARN: could not tick "List All Projects" — adding Organization only.');
  await page.waitForTimeout(800);
  await shot(page, "projects-ticked");

  const addNow = page.getByRole("button", { name: /add now/i }).first();
  await addNow.click({ timeout: 10000 }).catch(async () => {
    await page.locator(".lytePrimaryBtn").filter({ hasText: /add now/i }).last().click({ force: true });
  });
  await page.waitForTimeout(2500);
  await shot(page, "tool-added");
  console.log(`Ticked "Organization" + "List All Projects" and clicked "Add Now".`);
}

/** On a server: open the Connect tab and copy the (unmasked) MCP Server URL. */
async function grabMcpUrl(page) {
  console.log(`Fetching the MCP Server URL...`);
  await page.getByText(/^connect$/i).first().click();
  await page.waitForTimeout(2500);
  await page.locator("span.mcp-copy-btn, lyte-svg[lt-prop-path*=copy]").first().click();
  await page.waitForTimeout(600);
  const url = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  console.log(`  MCP URL: ${maskKey(url)}`);
  return url;
}

/**
 * MCP OAuth 2.1 client flow for an on-demand server. Discovers metadata ->
 * dynamic client registration -> PKCE -> drives the two consent screens (Allow,
 * then checkbox + Accept) in a logged-in tab -> captures the loopback code ->
 * exchanges for a token. Returns { ok, accessToken } (or an error object).
 */
async function authorizeOnDemand(context, mcpUrl) {
  const origin = new URL(mcpUrl).origin;
  const meta = await (await fetch(origin + "/.well-known/oauth-authorization-server")).json();
  const scope = (meta.scopes_supported || ["ZohoCatalyst.projects.READ", "ZohoMCP.tool.execute"]).join(" ");

  // Dynamic client registration (public PKCE client).
  const reg = await (
    await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "TriggerMCP OnDemand",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope,
      }),
    })
  ).json();
  if (!reg.client_id) return { ok: false, error: "OAuth: client registration failed", reg };
  console.log(`Registered OAuth client ${reg.client_id}`);

  // PKCE + authorize URL.
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(8));
  const authUrl =
    meta.authorization_endpoint +
    "?" +
    new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: REDIRECT_URI,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  // Capture the authorization code from the loopback redirect. A remote
  // SmartBrowz browser can refuse to navigate to localhost, so a `request` event
  // alone is unreliable — INTERCEPT the redirect with a route (fires inside the
  // browser before it tries to reach localhost) and short-circuit it with a 200.
  // Also listen on nav events and parse the code from query (?code=) OR fragment.
  let authCode = null;
  const grabCode = (u) => {
    if (authCode || typeof u !== "string" || !u.startsWith(REDIRECT_ORIGIN)) return;
    try {
      const url = new URL(u);
      authCode =
        url.searchParams.get("code") ||
        new URLSearchParams((url.hash || "").replace(/^#/, "")).get("code");
    } catch {}
  };
  await context
    .route(/localhost:53682/, async (route) => {
      grabCode(route.request().url());
      await route
        .fulfill({ status: 200, contentType: "text/plain", body: "ok" })
        .catch(() => {});
    })
    .catch(() => {});
  context.on("request", (r) => grabCode(r.url()));
  context.on("requestfailed", (r) => grabCode(r.url()));
  context.on("framenavigated", (f) => grabCode(f.url()));

  // Drive the consent screens (log whether each control actually fired).
  const authPage = await context.newPage();
  console.log("Opening authorize/consent page...");
  await authPage.goto(authUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  await authPage.waitForTimeout(3000);
  await shot(authPage, "oauth-consent-1");

  // Screen 1: "This application wants to access your Zoho MCP Account" -> Allow.
  const allowClicked = await authPage
    .getByRole("button", { name: /^allow$/i })
    .first()
    .click({ timeout: 15000 })
    .then(() => true)
    .catch(() =>
      authPage
        .locator(".lytePrimaryBtn, button:has-text('Allow')")
        .first()
        .click({ force: true, timeout: 8000 })
        .then(() => true)
        .catch(() => false),
    );

  // Screen 2: Zoho OAuth data consent -> tick "I allow ..." checkbox, then Accept.
  await authPage.locator("#user-consent-check").waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  const consentChecked = await authPage
    .locator("#user-consent-check")
    .check({ force: true })
    .then(() => true)
    .catch(() =>
      authPage
        .locator(".auth_checkbox, .trust_check")
        .first()
        .click({ timeout: 8000 })
        .then(() => true)
        .catch(() => false),
    );
  await authPage.waitForTimeout(400);
  await shot(authPage, "oauth-consent-2");
  const acceptClicked = await authPage
    .getByRole("button", { name: /^accept$/i })
    .first()
    .click({ timeout: 15000 })
    .then(() => true)
    .catch(() =>
      authPage
        .locator("button:has-text('Accept')")
        .first()
        .click({ force: true, timeout: 8000 })
        .then(() => true)
        .catch(() => false),
    );
  console.log(
    `OAuth consent: allow=${allowClicked} checkbox=${consentChecked} accept=${acceptClicked}`,
  );

  // Wait for the authorization code (from route interception or navigation).
  for (let i = 0; i < 40 && !authCode; i++) {
    grabCode(authPage.url());
    await authPage.waitForTimeout(500);
  }
  await shot(authPage, "oauth-after-consent");
  if (!authCode) {
    console.log(`OAuth: no code captured. Final consent-tab URL: ${authPage.url()}`);
    return { ok: false, error: "OAuth: no authorization code captured" };
  }
  console.log("Authorization code captured; exchanging for a token...");

  // Token exchange.
  const tok = await (
    await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: REDIRECT_URI,
        client_id: reg.client_id,
        code_verifier: verifier,
      }),
    })
  ).json();
  if (!tok.access_token) return { ok: false, error: "OAuth: token exchange failed", token: tok };
  console.log("Access token obtained.");
  return { ok: true, accessToken: tok.access_token };
}

/**
 * Acts as an MCP client against a server's streamable-HTTP endpoint:
 * initialize -> tools/list -> tools/call for EVERY configured tool. Pure JS — no
 * Claude involved. For an on-demand server, every request carries the OAuth
 * bearer token obtained by authorizeOnDemand().
 */
async function callAllTools(mcpUrl, bearer) {
  if (!/^https?:\/\//.test(mcpUrl || ""))
    return { ok: false, error: "no MCP URL captured" };
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
  const rpc = async (id, method, params) => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = await res.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}
    return { status: res.status, json, body };
  };
  const init = await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "TriggerMCP", version: "1.0" },
  });
  if (init.status !== 200 || !init.json?.result)
    return {
      ok: false,
      error: `initialize failed (HTTP ${init.status})`,
      body: (init.body || "").slice(0, 200),
    };
  const list = await rpc(2, "tools/list", {});
  const tools = list.json?.result?.tools || [];
  if (!tools.length) return { ok: false, error: "no tools listed" };

  const results = [];
  let id = 3;
  for (const tool of tools) {
    const call = await rpc(id++, "tools/call", { name: tool.name, arguments: {} });
    const result = call.json?.result;
    results.push({
      tool: tool.name,
      ok: result?.isError === false,
      isError: !!result?.isError,
      output:
        result?.content?.[0]?.text ||
        result?.structuredContent ||
        (call.body || "").slice(0, 200),
    });
  }
  return { ok: results.every((r) => r.ok), count: results.length, tools: results };
}

/** login -> create -> add tool -> grab URL -> OAuth + execute the tool. */
async function createOnDemandServer(serverName) {
  // --- Option A: launch a local Chromium (for local verification only) ---
  // CAVEAT: needs a real browser binary, which `playwright-core` does NOT ship.
  // To use Option A: switch the top require to full playwright
  // (`const { chromium } = require("playwright")`), run
  // `npx playwright install chromium`, then comment Option B and uncomment this.
  // Keep HEADLESS unset to watch it. (Option B is the one that works in a job.)
  // const HEADLESS = process.env.HEADLESS === "1";
  // console.log(`Launching Chromium (headless=${HEADLESS})...`);
  // const browser = await chromium.launch({
  //   headless: HEADLESS,
  //   slowMo: 200,
  //   args: ["--start-maximized"],
  // });

  // --- Option B: connect to Catalyst SmartBrowz remote (headless) Chrome ---
  // connectOverCDP is the Playwright equivalent of puppeteer.connect({ browserWSEndpoint }).
  // This is the mode that works inside a job (no local display / no bundled browser).
  console.log(`Connecting to Catalyst SmartBrowz (CDP)...`);
  const browser = await chromium.connectOverCDP(WEB_URL);
  const context = await browser.newContext({
    viewport: null,
    storageState: fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    await login(page);
    await page.waitForLoadState("networkidle").catch(() => {});
    await context.storageState({ path: AUTH_FILE }).catch(() => {});
    await page.waitForTimeout(2500);

    await createServerViaModal(page, serverName); // NOTE: no "Authorize via Connection" — left on-demand
    await addCatalystTool(page);
    const mcpUrl = await grabMcpUrl(page).catch(() => "");

    // On-demand servers require per-client OAuth — obtain a bearer token first.
    console.log(`\nRunning on-demand OAuth for "${serverName}"...`);
    const auth = await authorizeOnDemand(context, mcpUrl).catch((e) => ({ ok: false, error: e.message }));
    if (!auth.ok) {
      console.log(`  → OAuth failed: ${JSON.stringify(auth)}`);
      return { ok: false, server: { name: serverName, mcpUrl: maskKey(mcpUrl), execution: auth } };
    }

    // Execute every configured tool to verify they all work (pure JS MCP client,
    // using the OAuth bearer).
    console.log(`\nExecuting the configured tools on "${serverName}"...`);
    const execution = await callAllTools(mcpUrl, auth.accessToken).catch((e) => ({ ok: false, error: e.message }));
    console.log(`  → ${JSON.stringify(execution)}`);

    return { ok: !!execution.ok, server: { name: serverName, mcpUrl: maskKey(mcpUrl), execution } };
  } catch (err) {
    console.error("❌ Error:", err.message);
    await shot(page, "error");
    return { ok: false, server: { name: serverName }, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const name = jobRequest.getJobParam("name") || makeServerName("ServerOnDemand");
  let result;
  try {
    console.log(`Job started — on-demand MCP server: "${name}"`);
    result = await createOnDemandServer(name);
    console.log("JOB RESULT:", JSON.stringify(result));
  } catch (err) {
    console.error("Job failed:", err && err.stack ? err.stack : err);
    result = { ok: false, server: { name }, error: err && err.message ? err.message : String(err) };
  }

  // Persist result to Catalyst Cache (keyed by server name) for mcp_status_fetcher.
  try {
    const app = catalyst.initialize(context);
    await app.cache().segment().put(cacheKey(name), JSON.stringify(result));
    console.log(`Result cached under key "${cacheKey(name)}".`);
  } catch (e) {
    console.error("Failed to cache result:", e && e.message ? e.message : e);
  }

  if (result.ok) context.closeWithSuccess();
  else context.closeWithFailure();
};
