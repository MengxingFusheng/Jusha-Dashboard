#!/usr/bin/env node

const options = parseArgs(process.argv.slice(2));
const baseUrl = options.baseUrl || "http://localhost:3000";
const iterations = Math.max(1, Number(options.iterations || 1));
const timeoutMs = Math.max(1000, Number(options.timeoutMs || 45000));

const originalState = await apiGet("/api/state");
const originalConfig = originalState.config;
const originalNodeSettings = originalState.nodeSettings || {};

for (let index = 1; index <= iterations; index += 1) {
  const result = await runIteration(index);
  console.log(`OK ${index}/${iterations} ${result.resourceCount} resources, ${result.incomeCount} income rows`);
}

await apiPost("/api/config", originalConfig);
await apiPost("/api/node-order", { uuids: originalNodeSettings.nodeOrderUuids || [] });

async function runIteration(index) {
  const html = await requestText("/");
  assert(html.includes("Dash Board"), `iteration ${index}: dashboard html missing title`);

  const appJs = await requestText("/app.js");
  assert(appJs.includes("loadState"), `iteration ${index}: frontend script missing expected code`);

  const css = await requestText("/styles.css");
  assert(css.includes("resource-tile"), `iteration ${index}: stylesheet missing resource tile styles`);

  const stateBefore = await apiGet("/api/state");
  const resources = stateBefore.state?.latest?.resources || [];
  assert(Array.isArray(resources), `iteration ${index}: resources is not an array`);
  assert(resources.length > 0, `iteration ${index}: no resources loaded`);

  await apiPost("/api/config", stateBefore.config);

  const uuids = resources.map((item) => item.uuid).filter(Boolean);
  const testUuid = uuids[0];
  assert(testUuid, `iteration ${index}: no resource uuid available`);

  const nodeSettings = stateBefore.nodeSettings || {};
  await apiPost("/api/node-order", { uuids: nodeSettings.nodeOrderUuids?.length ? nodeSettings.nodeOrderUuids : uuids });
  await apiPost("/api/node-visibility", {
    uuid: testUuid,
    hidden: Boolean(nodeSettings.hiddenNodeUuids?.includes(testUuid))
  });
  await apiPost("/api/node-alerts", {
    uuid: testUuid,
    alerts: nodeSettings.nodeAlerts?.[testUuid] || []
  });
  await apiPost("/api/node-monitor-setting", {
    uuid: testUuid,
    monitor: nodeSettings.nodeMonitors?.[testUuid] || null
  });
  if (!nodeSettings.nodeAlertMutes?.[testUuid]) {
    await apiPost("/api/node-alert-mute", { uuid: testUuid, duration: "none" });
  }

  await apiPost("/api/serverchan-settings", {
    enabled: Boolean(stateBefore.config?.serverChan?.enabled),
    cooldownSeconds: Number(stateBefore.config?.serverChan?.cooldownSeconds || 0),
    subjectPrefix: stateBefore.config?.serverChan?.subjectPrefix || "[聚沙]",
    pushItems: stateBefore.config?.serverChan?.pushItems || {}
  });

  const checkResult = await apiPost("/api/check");
  assert(checkResult.ok !== false, `iteration ${index}: resource check failed`);
  assert((checkResult.resources || []).length > 0, `iteration ${index}: resource check returned no resources`);

  const income = await apiPost("/api/income/check");
  assert(income.status !== "error", `iteration ${index}: income check failed: ${income.error || "unknown"}`);
  assert((income.items || []).length > 0, `iteration ${index}: income check returned no rows`);

  const stateAfter = await apiGet("/api/state");
  assert(stateAfter.income?.status !== "error", `iteration ${index}: state income is still error`);
  assert((stateAfter.state?.latest?.resources || []).length > 0, `iteration ${index}: final state has no resources`);

  return {
    resourceCount: stateAfter.state.latest.resources.length,
    incomeCount: stateAfter.income.items.length
  };
}

async function apiGet(path) {
  const response = await request(path);
  return response.json;
}

async function apiPost(path, body = undefined) {
  const response = await request(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return response.json;
}

async function requestText(path) {
  const response = await request(path);
  return response.text;
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL(path, baseUrl);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok) {
      throw new Error(`${init.method || "GET"} ${url.pathname} HTTP ${response.status}: ${json?.error || text}`);
    }
    return { response, text, json };
  } finally {
    clearTimeout(timeout);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(args) {
  const result = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) result[toCamelCase(match[1])] = match[2];
  }
  return result;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
