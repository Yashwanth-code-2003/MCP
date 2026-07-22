import Express from "express";
import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const app = Express();
const port = process.env.X_ZOHO_CATALYST_LISTEN_PORT || 9000;

// --- Config (env with test-account fallbacks) ---
const BASE_URL = "https://mcp.localzoho.com/";
const EMAIL = process.env.MCP_EMAIL || "yashwanth.v+mcp@zohotest.com";
const PASSWORD = process.env.MCP_PASSWORD || "12345@Catalyst";
const HEADLESS = process.env.HEADLESS === "1";
// Claude drives the MCP tool calls via the Anthropic SDK (reads ANTHROPIC_API_KEY).
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.join(__dirname, "screenshots");
const AUTH_FILE = path.join(__dirname, "auth.json");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

function makeServerName(prefix = "ServerViaConnection") {
  // Unique-per-run so repeat triggers don't collide on a duplicate name.
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  return `${prefix}-${stamp}`;
}

async function shot(page, name) {
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
}

async function login(page) {
  console.log(`Navigating to ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  if (!/accounts\.localzoho\.com/.test(page.url())) {
    console.log("Already authenticated (cached session).");
    return;
  }

  console.log("Signing in. Entering email...");
  const emailField = page
    .locator("#login_id, input[name='LOGIN_ID'], input[type='email']")
    .first();
  // The accounts page sometimes opens on the "Smart Sign-in via OneAuth" (QR)
  // screen, where the email field is hidden. Switch to email/password sign-in.
  if (!(await emailField.isVisible().catch(() => false))) {
    console.log(
      "Smart Sign-in screen detected — switching to email sign-in...",
    );
    await page
      .getByText(/sign in via email/i)
      .first()
      .click({ timeout: 10000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
  }
  await emailField.waitFor({ state: "visible", timeout: 30000 });
  await emailField.fill(EMAIL);
  await page
    .locator("#nextbtn, #nextbtn_myzoho, button:has-text('Next')")
    .first()
    .click();

  console.log("Entering password...");
  const pwField = page
    .locator("#password, input[name='PASSWORD'], input[type='password']")
    .first();
  await pwField.waitFor({ state: "visible" });
  await pwField.fill(PASSWORD);
  await page
    .locator("#nextbtn, button:has-text('Sign in'), #signin_submit")
    .first()
    .click();

  console.log("Waiting to return to MCP portal...");
  // The accounts URL contains "mcp.localzoho.com" inside its serviceurl query
  // param, so match on the real hostname, not a substring.
  await page.waitForFunction(
    () => window.location.hostname === "mcp.localzoho.com",
    undefined,
    {
      timeout: 90000,
    },
  );
}

/** On the new server's Tools page: Add Tools -> search "catalyst" -> pick it. */
async function addCatalystTool(page, label = "") {
  console.log(`Adding tool: searching "catalyst"...`);

  // 1. Click "Add Tools".
  const addBtn = page.getByRole("button", { name: /add tools/i }).first();
  await addBtn.waitFor({ state: "visible", timeout: 20000 });
  await addBtn.click();
  await page.waitForTimeout(2000);
  await shot(page, `add-tools${label}`);

  // --- discovery: dump inputs + visible clickable text so we can wire selectors ---
  const probe = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const inputs = [...document.querySelectorAll("input, textarea")]
      .filter(vis)
      .map((i) => ({
        id: i.id,
        ph: i.getAttribute("placeholder"),
        cls: (i.className || "").slice(0, 40),
      }));
    const texts = [...document.querySelectorAll("*")]
      .filter(
        (el) =>
          vis(el) &&
          /catalyst/i.test(el.textContent || "") &&
          el.children.length === 0,
      )
      .map((el) => (el.textContent || "").trim().slice(0, 50));
    return { inputs, catalystTexts: [...new Set(texts)].slice(0, 15) };
  });
  console.log("ADD-TOOLS inputs:", JSON.stringify(probe.inputs));
  console.log(
    "ADD-TOOLS catalyst matches:",
    JSON.stringify(probe.catalystTexts),
  );

  // 2. Search for "catalyst" (the panel's search box is placeholder "Browse products").
  const search = page.getByPlaceholder(/browse products|search/i).last();
  await search.waitFor({ state: "visible", timeout: 15000 });
  await search.click();
  await search.pressSequentially("catalyst", { delay: 60 });
  await search.dispatchEvent("change");
  await page.waitForTimeout(2000);
  await shot(page, `search-catalyst${label}`);

  // 3. Click "Catalyst by Zoho LZ".
  const item = page.getByText(/catalyst by zoho\s*lz/i).first();
  await item.waitFor({ state: "visible", timeout: 15000 });
  await item.click();
  await page.waitForTimeout(2000);
  await shot(page, `tool-selected${label}`);
  console.log(`Selected "Catalyst by Zoho LZ".`);

  // 4. Tick the "Organization" group checkbox.
  console.log(`Ticking the "Organization" group...`);
  await page
    .getByRole("button", { name: /add now/i })
    .first()
    .waitFor({ state: "visible", timeout: 15000 });

  // --- discovery: how are the group cards / checkboxes structured? ---
  const groupProbe = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const cbs = [
      ...document.querySelectorAll(
        "input[type=checkbox], lyte-checkbox, [class*=heckbox]",
      ),
    ]
      .filter(vis)
      .slice(0, 5)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 50),
      }));
    const org = [...document.querySelectorAll("*")].find(
      (el) => vis(el) && (el.textContent || "").trim() === "Organization",
    );
    return {
      checkboxSample: cbs,
      orgCardHtml: org
        ? org.closest("div")?.parentElement?.outerHTML.slice(0, 500)
        : "(not found)",
    };
  });
  console.log("CHECKBOX sample:", JSON.stringify(groupProbe.checkboxSample));
  console.log("ORG card html:", groupProbe.orgCardHtml);

  // Best-effort: click the checkbox inside the card that contains "Organization".
  const orgCard = page
    .locator("div")
    .filter({ has: page.getByText("Organization", { exact: true }) })
    .last();
  const orgCheckbox = orgCard
    .locator("input[type=checkbox], lyte-checkbox, [class*=heckbox]")
    .first();
  await orgCheckbox.click({ timeout: 10000 }).catch(async () => {
    // Fallback: click the "Organization" label itself.
    await page.getByText("Organization", { exact: true }).first().click();
  });
  await page.waitForTimeout(1000);
  await shot(page, `org-ticked${label}`);

  // 4b. Also select the specific "List All Projects" tool from the Projects group.
  //     Ticking a group card selects ALL its tools, so instead open the Projects
  //     group (click its title) and tick only that one tool. Selections persist
  //     across groups, so a single "Add Now" adds both.
  console.log(`Selecting "List All Projects" from the Projects group...`);
  await page.getByText("Projects", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page
    .locator("lyte-checkbox")
    .filter({ hasText: /list all projects/i })
    .first()
    .click({ timeout: 10000 })
    .catch(async () => {
      await page
        .getByText(/^list all projects$/i)
        .first()
        .click();
    });
  await page.waitForTimeout(800);
  await shot(page, `projects-ticked${label}`);

  // 5. Click "Add Now".
  const addNow = page.getByRole("button", { name: /add now/i }).first();
  await addNow.click({ timeout: 10000 }).catch(async () => {
    await page
      .locator(".lytePrimaryBtn")
      .filter({ hasText: /add now/i })
      .last()
      .click({ force: true });
  });
  await page.waitForTimeout(2500);
  await shot(page, `tool-added${label}`);
  console.log(`Ticked "Organization" and clicked "Add Now".`);
}

/** On the server-list page: open the create modal, name it, submit. Returns the URL. */
async function createServerViaModal(page, serverName) {
  console.log(`Opening the "Create MCP server" flow for "${serverName}"...`);
  // Target the specific "Create MCP server" trigger (avoid a broad /create/
  // match that can hit the wrong node). Retry the click until the modal's name
  // field actually appears.
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

  // Dialog: single "Enter server name" field + Create / Cancel.
  // NOTE: the portal uses Zoho "lyte" web components — a plain fill() doesn't
  // register, so type the value and click the primary button explicitly.
  await nameField.waitFor({ state: "visible", timeout: 20000 });
  console.log(`Entering server name: "${serverName}"`);
  await nameField.click();
  await nameField.pressSequentially(serverName, { delay: 40 });
  // The lyte-input has lt-prop-auto-update="false", so it only commits the typed
  // value into its bound model on blur/change. Without this, submitForm() reads
  // an empty value, fails the ".+" pattern check, and the modal silently stays
  // open. Fire change + blur to commit before submitting.
  await nameField.dispatchEvent("change");
  await nameField.evaluate((el) => el.blur());
  await page.waitForTimeout(400);
  await shot(page, `create-form-${serverName}`);

  const submitBtn = page
    .locator(".lytePrimaryBtn")
    .filter({ hasText: /create/i })
    .last();
  await submitBtn.click({ timeout: 10000 }).catch(async () => {
    await page
      .getByRole("button", { name: /^create$/i })
      .last()
      .click({ force: true });
  });
  console.log("Submitted. Waiting for the server to be created...");

  await Promise.race([
    nameField.waitFor({ state: "detached", timeout: 30000 }).catch(() => {}),
    page
      .getByText(serverName, { exact: false })
      .first()
      .waitFor({ timeout: 30000 })
      .catch(() => {}),
  ]);
  await page.waitForTimeout(2500);
  await shot(page, `created-${serverName}`);
  const url = page.url();
  console.log(`Server "${serverName}" created. Now at: ${url}`);
  return url;
}

/** On a server: open the Connection tab and switch auth to "Authorize via Connection". */
async function configureConnection(page) {
  console.log(`Opening the "Connection" tab...`);
  // Sidebar has both "Connect" and "Connection" — match exactly.
  await page.getByText("Connection", { exact: true }).first().click();
  await page.waitForTimeout(2500);
  await shot(page, "connection-tab");

  // --- discovery: dump the Connection tab's controls so we can wire edit/save ---
  const probe = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const clickables = [
      ...document.querySelectorAll(
        "button, [role=button], [class*=btn], [class*=Btn], [class*=edit], [class*=Edit]",
      ),
    ]
      .filter(vis)
      .map((el) =>
        (el.innerText || el.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 40),
      )
      .filter(Boolean);
    const inputs = [
      ...document.querySelectorAll(
        "input, textarea, select, lyte-radio, [class*=adio], [class*=oggle]",
      ),
    ]
      .filter(vis)
      .map((i) => ({
        tag: i.tagName.toLowerCase(),
        type: i.getAttribute("type"),
        cls: (i.className || "").toString().slice(0, 40),
        ph: i.getAttribute("placeholder"),
      }));
    const authTexts = [...document.querySelectorAll("*")]
      .filter(
        (el) =>
          vis(el) &&
          /authoriz|connection|on demand/i.test(el.textContent || "") &&
          el.children.length === 0,
      )
      .map((el) => (el.textContent || "").trim().slice(0, 60));
    return {
      clickables: [...new Set(clickables)].slice(0, 30),
      inputs: inputs.slice(0, 20),
      authTexts: [...new Set(authTexts)].slice(0, 20),
    };
  });
  console.log("CONNECTION clickables:", JSON.stringify(probe.clickables));
  console.log("CONNECTION inputs:", JSON.stringify(probe.inputs));
  console.log("CONNECTION auth texts:", JSON.stringify(probe.authTexts));

  // 1. Click "Edit" to enable changing the authorization type.
  console.log(`Clicking "Edit"...`);
  await page
    .getByText(/^edit$/i)
    .first()
    .click()
    .catch(async () => {
      await page.getByRole("button", { name: /edit/i }).first().click();
    });
  await page.waitForTimeout(1500);
  await shot(page, "connection-edit");

  // --- discovery: what became selectable after Edit? ---
  const editProbe = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const radios = [
      ...document.querySelectorAll(
        "input[type=radio], lyte-radio, [class*=adio]",
      ),
    ]
      .filter(vis)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 50),
      }));
    const buttons = [
      ...document.querySelectorAll("button, [class*=Btn], [class*=btn]"),
    ]
      .filter(vis)
      .map((el) => (el.innerText || "").trim().slice(0, 30))
      .filter(Boolean);
    return {
      radios: radios.slice(0, 8),
      buttons: [...new Set(buttons)].slice(0, 15),
    };
  });
  console.log("AFTER-EDIT radios:", JSON.stringify(editProbe.radios));
  console.log("AFTER-EDIT buttons:", JSON.stringify(editProbe.buttons));

  // 2. Select "Authorize via Connection" inside the edit modal.
  //    NOTE: the modal option reads "Authorize via Connection" (not "Authorization"),
  //    and it's a lyte-radiobutton — click the radio, not the background page header
  //    (which sits behind the modal's freeze overlay and intercepts clicks).
  console.log(`Selecting "Authorize via Connection"...`);
  const viaOption = page
    .locator("lyte-radiobutton")
    .filter({ hasText: /authorize via connection/i })
    .first();
  await viaOption.click({ timeout: 15000 }).catch(async () => {
    await page
      .getByText(/authorize via connection/i)
      .first()
      .click();
  });
  await page.waitForTimeout(800);
  await shot(page, "connection-selected");

  // 3. Save — the modal's primary button is labeled "Update".
  console.log(`Clicking "Update" to save...`);
  const saveBtn = page
    .getByRole("button", { name: /^(update|save)$/i })
    .first();
  await saveBtn.click({ timeout: 10000 }).catch(async () => {
    await page
      .locator(".lytePrimaryBtn")
      .filter({ hasText: /update|save/i })
      .last()
      .click({ force: true });
  });
  await page.waitForTimeout(2500);
  await shot(page, "connection-saved");
  console.log(`Switched to "Authorize via Connection" and saved.`);

  // 4. Authorize the connection (opens an OAuth flow in a new tab).
  await authorizeViaConnection(page);
}

/**
 * In the Authorized Tools row: ⋯ menu -> Authorize (opens the Zoho OAuth consent
 * in a new tab) -> tick the consent checkbox -> Accept. The consent tab
 * auto-closes on redirect, leaving the connection authorized.
 */
async function authorizeViaConnection(page) {
  console.log(`Authorizing the connection...`);
  await page.waitForTimeout(1500);
  await shot(page, "authorized-tools");

  // 1. Open the row's ⋯ menu (lyte-td.table-toolkit with the three-dots icon).
  await page
    .locator("[id^=mcp_open_menu], .table-toolkit-three-dots")
    .first()
    .click();
  await page.waitForTimeout(1000);
  await shot(page, "authorize-menu");

  // 2. Click "Authorize" — opens the OAuth consent screen in a new tab.
  const popupPromise = page.context().waitForEvent("page", { timeout: 25000 });
  await page
    .getByRole("menuitem", { name: /authorize/i })
    .first()
    .click({ timeout: 15000 })
    .catch(async () => {
      await page
        .locator("lyte-menu-item:has-text('Authorize')")
        .first()
        .click({ force: true });
    });

  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await popup.waitForLoadState("networkidle").catch(() => {});
  await popup.waitForTimeout(1500);
  console.log(`OAuth consent tab: ${popup.url()}`);
  await shot(popup, "oauth-consent");

  // 3. Tick the consent checkbox ("I allow ... to access the above data").
  await popup
    .locator("#user-consent-check")
    .check({ force: true })
    .catch(async () => {
      await popup.locator(".auth_checkbox, .trust_check").first().click();
    });
  await popup.waitForTimeout(500);
  await shot(popup, "oauth-consent-checked");

  // 4. Click "Accept" to confirm. The tab redirects and closes itself.
  await popup
    .getByRole("button", { name: /^accept$/i })
    .first()
    .click()
    .catch(async () => {
      await popup.locator("button:has-text('Accept')").first().click();
    });

  // The consent tab auto-closes after the OAuth redirect — wait for it, but
  // don't fail if it's already gone.
  await popup.waitForEvent("close", { timeout: 15000 }).catch(() => {});
  console.log(`Consent tab closed: ${popup.isClosed()}`);

  // 5. Back on the portal — confirm the connection is now authorized.
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(4000);
  await shot(page, "connection-authorized");
  const status = await page
    .evaluate(() => {
      const el = [...document.querySelectorAll("*")].find(
        (e) =>
          e.children.length === 0 &&
          /connected|not yet/i.test(e.textContent || ""),
      );
      return el ? el.textContent.trim() : "(status unknown)";
    })
    .catch(() => "(status unknown)");
  console.log(`Authorization done. Connection status: "${status}"`);
}

const maskKey = (url) => (url || "").replace(/\/mcp\/[^/]+\//, "/mcp/****/");

/** On a server: open the Connect tab and copy the (unmasked) MCP Server URL. */
async function grabMcpUrl(page, label = "") {
  console.log(`Fetching the MCP Server URL from the Connect tab...`);
  await page
    .getByText(/^connect$/i)
    .first()
    .click();
  await page.waitForTimeout(2500);
  await shot(page, `connect${label}`);
  // The displayed URL is masked; the copy button puts the real URL on the clipboard.
  await page
    .locator("span.mcp-copy-btn, lyte-svg[lt-prop-path*=copy]")
    .first()
    .click();
  await page.waitForTimeout(600);
  const url = await page.evaluate(() =>
    navigator.clipboard.readText().catch(() => ""),
  );
  console.log(`  MCP URL: ${maskKey(url)}`);
  return url;
}

/**
 * A tiny MCP-over-HTTP (streamable-HTTP) transport. POSTs JSON-RPC, captures/
 * echoes the Mcp-Session-Id header and tolerates responses
 * framed as SSE ("data: {...}" lines) as well as plain JSON.
 */
function makeMcpTransport(mcpUrl) {
  let sessionId = null;
  const parseBody = (body) => {
    try {
      return JSON.parse(body);
    } catch {}
    // SSE framing: pick the last "data:" line that parses as JSON.
    let found = null;
    for (const line of (body || "").split(/\r?\n/)) {
      const m = /^data:\s*(.*)$/.exec(line);
      if (!m) continue;
      try {
        found = JSON.parse(m[1]);
      } catch {}
    }
    return found;
  };
  const rpc = async (id, method, params) => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
    // A null id marks a JSON-RPC notification (no response expected).
    const payload = { jsonrpc: "2.0", method, params };
    if (id !== null) payload.id = id;
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const body = await res.text();
    return { status: res.status, json: parseBody(body), body };
  };
  return { rpc };
}

/**
 * Verifies the MCP server the way a real client would: hands the server's tools
 * to Claude (via the Anthropic SDK + ANTHROPIC_API_KEY) and lets Claude decide
 * which to call. Claude runs on Anthropic's side, but the MCP connection itself
 * is opened from THIS process — so an internal host like mcp.localzoho.com works
 * (the Anthropic-hosted MCP connector, which dials out from Anthropic's cloud,
 * could not reach it). We proxy each tool_use Claude emits to tools/call and feed
 * the result back until Claude finishes.
 */
async function callToolsViaClaude(mcpUrl) {
  if (!process.env.ANTHROPIC_API_KEY)
    return { ok: false, error: "ANTHROPIC_API_KEY not set" };
  if (!/^https?:\/\//.test(mcpUrl || ""))
    return { ok: false, error: "no MCP URL captured" };

  const { rpc } = makeMcpTransport(mcpUrl);

  const init = await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "TriggerMCP-Claude", version: "1.0" },
  });
  if (init.status === 401) {
    return {
      ok: false,
      authRequired: true,
      note: "Authorization on Demand — the MCP client must complete OAuth (HTTP 401).",
    };
  }
  if (init.status !== 200 || !init.json?.result) {
    return {
      ok: false,
      error: `initialize failed (HTTP ${init.status})`,
      body: (init.body || "").slice(0, 200),
    };
  }
  // Per the MCP spec the client sends this after initialize; best-effort.
  await rpc(null, "notifications/initialized", {}).catch(() => {});

  const list = await rpc(2, "tools/list", {});
  const mcpTools = list.json?.result?.tools || [];
  if (!mcpTools.length) return { ok: false, error: "no tools listed" };

  // MCP tool -> Anthropic tool definition.
  const tools = mcpTools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));

  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const messages = [
    {
      role: "user",
      content:
        "You are connected to an MCP server exposing the tools provided. " +
        "Call each available tool once to verify it works, then give a brief " +
        "plain-text summary of what each returned. Call tools ONE AT A TIME " +
        "(not in parallel): wait for each result before the next call, and reuse " +
        "identifiers returned by earlier calls (e.g. an organization/project ID) " +
        "as arguments to dependent later calls instead of guessing placeholder values.",
    },
  ];
  const toolsCalled = [];
  let id = 3;

  // Bounded tool-use loop: execute Claude's tool_use blocks against the MCP
  // server and feed the results back until Claude stops calling tools.
  for (let turn = 0; turn < 8; turn++) {
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      tools,
      // At most one tool call per turn so Claude sees each result before the
      // next call — lets dependent calls reuse real IDs instead of placeholders.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages,
    });

    if (resp.stop_reason !== "tool_use") {
      const summary = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { ok: true, model: resp.model, toolsCalled, summary };
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const call = await rpc(id++, "tools/call", {
        name: block.name,
        arguments: block.input || {},
      });
      const result = call.json?.result;
      const isError = !!result?.isError;
      const text =
        result?.content?.[0]?.text ??
        JSON.stringify(result?.structuredContent ?? result ?? {}).slice(
          0,
          2000,
        );
      toolsCalled.push({ tool: block.name, isError });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(text),
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { ok: false, error: "tool-use loop did not converge", toolsCalled };
}

/**
 * Drives the headed browser end to end for a single "Authorize via Connection"
 * server: login (cached) -> create the server -> add the "Catalyst by Zoho LZ"
 * tool (Organization action) -> switch auth to "Authorize via Connection" and
 * authorize it -> grab its MCP URL -> execute the tool to verify it works.
 */
async function createViaConnectionServer(serverName) {
  // --- Option A: launch a local Chromium (default; headed for now) ---
  console.log(`Launching Chromium (headless=${HEADLESS})...`);
  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: 200,
    args: ["--start-maximized"],
  });

  // --- Option B: connect to Catalyst SmartBrowz remote (headless) Chrome ---
  // NOTE: this project uses Playwright, so we use chromium.connectOverCDP() —
  // the equivalent of puppeteer.connect({ browserWSEndpoint }). The SmartBrowz
  // endpoint is a CDP WebSocket. Comment this block and uncomment Option A to
  // go back to the local browser.
  // const WebUrl =
  //   "ws://browser360.localcatalystserverless.app/hub?project-id=21961000000017052&grid-id=2745000002385011&api-key=a3bfed13e60531de93645960be18ff3557473ced307b56c872e5ab62a5f964df1148285f95b11ce2dc0e15b428546989494adb3749519fad8d90acaa3cc19c79";
  // console.log(`Connecting to Catalyst SmartBrowz (CDP)...`);
  // const browser = await chromium.connectOverCDP(WebUrl);
  const context = await browser.newContext({
    viewport: null,
    storageState: fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
    permissions: ["clipboard-read", "clipboard-write"], // to copy the Server URL
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    await login(page);
    await page.waitForLoadState("networkidle").catch(() => {});
    await context.storageState({ path: AUTH_FILE }); // cache session for next run
    console.log(`Now at: ${page.url()}`);
    await page.waitForTimeout(2500); // let the SPA render

    await createServerViaModal(page, serverName);
    await addCatalystTool(page);
    await configureConnection(page); // switch to "Authorize via Connection" + authorize
    const mcpUrl = await grabMcpUrl(page).catch(() => "");

    // Verify the server by driving its tools with Claude via the Anthropic SDK:
    // Claude picks the tools to call; this process proxies them to the MCP server.
    console.log(`\nExecuting the tools via Claude on "${serverName}"...`);
    const claudeExecution = await callToolsViaClaude(mcpUrl).catch((e) => ({
      ok: false,
      error: e.message,
    }));
    console.log(`  → ${JSON.stringify(claudeExecution)}`);

    // Leave the browser open on purpose (headed run for inspection).
    return {
      ok: true,
      server: {
        name: serverName,
        mcpUrl: maskKey(mcpUrl),
        claudeExecution,
      },
    };
  } catch (err) {
    console.error("❌ Error:", err.message);
    await shot(page, "error");
    return { ok: false, server: { name: serverName }, error: err.message };
  }
}

// --- Routes ---
// Hitting the app runs the full "Authorize via Connection" flow (this is the
// "TriggerMCP" AppSail): create ServerViaConnection-<stamp> (override with
// ?name=), add the "Catalyst by Zoho LZ" tool (Organization action), switch auth
// to "Authorize via Connection", authorize it, and execute the tool to verify.
app.get("/", async (req, res) => {
  const name = req.query.name || makeServerName("ServerViaConnection");
  console.log(`Trigger received — creating MCP server: "${name}"`);
  const result = await createViaConnectionServer(name);
  res.status(result.ok ? 200 : 500).json(result);
});

app.listen(port, () => {
  console.log(`TriggerMCP listening on port ${port}`);
  console.log(`Open http://localhost:${port}/ to create an MCP server`);
});
