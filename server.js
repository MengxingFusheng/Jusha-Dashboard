import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config", "monitor.config.json");
const HISTORY_PATH = path.join(__dirname, "data", "history.json");
const STATE_PATH = path.join(__dirname, "data", "state.json");
const NODE_SETTINGS_PATH = path.join(__dirname, "data", "node-settings.json");
const ENV_PATH = path.join(__dirname, ".env");
const PUBLIC_DIR = path.join(__dirname, "public");

await loadEnv(ENV_PATH);

const PORT = Number(process.env.PORT || 3000);

let config = await readJson(CONFIG_PATH);
let history = await readJson(HISTORY_PATH, []);
let state = await readJson(STATE_PATH, {
  running: true,
  lastRun: null,
  nextRun: null,
  latest: null,
  activeAlerts: [],
  lastEmailByRule: {},
  lastNodeAlertByRule: {}
});
let nodeSettings = normalizeNodeSettings(await readJson(NODE_SETTINGS_PATH, {}));
let timer = null;
const clients = new Set();

startScheduler();

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/events") return handleEvents(req, res);
    if (req.url === "/api/state" && req.method === "GET") return sendJson(res, getPublicState());
    if (req.url === "/api/config" && req.method === "GET") return sendJson(res, config);
    if (req.url === "/api/config" && req.method === "POST") return updateConfig(req, res);
    if (req.url === "/api/login" && req.method === "POST") return loginEndpoint(req, res);
    if (req.url === "/api/node-visibility" && req.method === "POST") return updateNodeVisibility(req, res);
    if (req.url === "/api/node-alerts" && req.method === "POST") return updateNodeAlerts(req, res);
    if (req.url === "/api/node-alert-mute" && req.method === "POST") return updateNodeAlertMute(req, res);
    if (req.url === "/api/node-monitor-setting" && req.method === "POST") return updateNodeMonitorSetting(req, res);
    if (req.url === "/api/node-order" && req.method === "POST") return updateNodeOrder(req, res);
    if (req.url === "/api/serverchan-settings" && req.method === "POST") return updateServerChanSettings(req, res);
    if (req.url === "/api/check" && req.method === "POST") return runCheckEndpoint(res);
    if (req.url === "/api/test-serverchan" && req.method === "POST") return testServerChanEndpoint(res);
    if (req.url?.startsWith("/api/")) return sendJson(res, { error: "Not found" }, 404);
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, { error: error.message || "Server error" }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Resource monitor running at http://localhost:${PORT}`);
});

function startScheduler() {
  clearTimeout(timer);
  if (!state.running) return;
  const intervalMs = Math.max(10, Number(config.schedule?.intervalSeconds || 60)) * 1000;
  const delay = state.lastRun ? intervalMs : 1000;
  state.nextRun = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(async () => {
    await runCheck();
    startScheduler();
  }, delay);
}

async function runCheckEndpoint(res) {
  const result = await runCheck();
  startScheduler();
  return sendJson(res, result);
}

async function testServerChanEndpoint(res) {
  await sendServerChanAlert({
    rule: { id: "test-serverchan", severity: "info", message: "这是一条 Server酱测试推送" },
    metricValue: "OK",
    snapshot: state.latest || { metrics: {}, target: config.target, checkedAt: new Date().toISOString() }
  }, true);
  return sendJson(res, { ok: true });
}

async function loginEndpoint(req, res) {
  const { username, password } = await readBodyJson(req);
  if (!username || !password) {
    return sendJson(res, { error: "请输入账号和密码" }, 400);
  }

  const login = await loginTargetSite({ username, password });
  if (!login.success) {
    return sendJson(res, { error: login.message || "登录失败", status: login.status }, 401);
  }

  process.env.MONITOR_COOKIE = login.cookie;
  await upsertEnvValue(ENV_PATH, "MONITOR_COOKIE", login.cookie);
  await upsertEnvValue(ENV_PATH, "MONITOR_USER_AGENT", defaultUserAgent());
  const snapshot = await runCheck();
  startScheduler();
  return sendJson(res, {
    ok: true,
    message: "登录成功，Cookie 已保存",
    username,
    checkedAt: snapshot.checkedAt,
    metrics: snapshot.metrics,
    alerts: snapshot.alerts || []
  });
}

async function updateConfig(req, res) {
  const next = await readBodyJson(req);
  validateConfig(next);
  config = next;
  await writeJson(CONFIG_PATH, config);
  await publish();
  startScheduler();
  return sendJson(res, config);
}

async function updateNodeVisibility(req, res) {
  const { uuid, hidden } = await readBodyJson(req);
  if (!uuid) return sendJson(res, { error: "uuid is required" }, 400);
  const hiddenSet = new Set(nodeSettings.hiddenNodeUuids || []);
  if (hidden) hiddenSet.add(uuid);
  else hiddenSet.delete(uuid);
  nodeSettings.hiddenNodeUuids = [...hiddenSet];
  await persistNodeSettings();
  await publish();
  return sendJson(res, { ok: true, nodeSettings });
}

async function updateNodeAlerts(req, res) {
  const { uuid, alerts } = await readBodyJson(req);
  if (!uuid) return sendJson(res, { error: "uuid is required" }, 400);
  if (!Array.isArray(alerts)) return sendJson(res, { error: "alerts must be an array" }, 400);
  const normalizedAlerts = normalizeNodeAlertRules(alerts, uuid);
  const nextNodeAlerts = { ...nodeSettings.nodeAlerts };
  if (normalizedAlerts.length) nextNodeAlerts[uuid] = normalizedAlerts;
  else delete nextNodeAlerts[uuid];
  nodeSettings.nodeAlerts = {
    ...nextNodeAlerts
  };
  await persistNodeSettings();
  await publish();
  return sendJson(res, { ok: true, nodeSettings });
}

async function updateNodeAlertMute(req, res) {
  const { uuid, duration } = await readBodyJson(req);
  if (!uuid) return sendJson(res, { error: "uuid is required" }, 400);

  const nextMutes = { ...(nodeSettings.nodeAlertMutes || {}) };
  const now = Date.now();
  const key = String(duration || "").trim();
  if (key === "none") {
    delete nextMutes[uuid];
  } else if (key === "1h" || key === "24h") {
    const hours = key === "1h" ? 1 : 24;
    nextMutes[uuid] = {
      mode: "until",
      until: new Date(now + hours * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now).toISOString()
    };
  } else if (key === "forever") {
    nextMutes[uuid] = {
      mode: "permanent",
      until: null,
      updatedAt: new Date(now).toISOString()
    };
  } else {
    return sendJson(res, { error: "duration must be 1h, 24h, forever, or none" }, 400);
  }

  nodeSettings.nodeAlertMutes = nextMutes;
  await persistNodeSettings();
  await publish();
  return sendJson(res, { ok: true, nodeSettings });
}

async function updateNodeMonitorSetting(req, res) {
  const { uuid, monitor } = await readBodyJson(req);
  if (!uuid) return sendJson(res, { error: "uuid is required" }, 400);
  const normalized = normalizeNodeMonitorSetting(monitor);
  const nextMonitors = { ...(nodeSettings.nodeMonitors || {}) };
  if (normalized) nextMonitors[uuid] = normalized;
  else delete nextMonitors[uuid];
  nodeSettings.nodeMonitors = nextMonitors;
  await persistNodeSettings();
  await publish();
  return sendJson(res, { ok: true, nodeSettings });
}

async function updateNodeOrder(req, res) {
  const { uuids } = await readBodyJson(req);
  if (!Array.isArray(uuids)) return sendJson(res, { error: "uuids must be an array" }, 400);
  nodeSettings.nodeOrderUuids = [...new Set(uuids.filter(Boolean).map(String))];
  await persistNodeSettings();
  await publish();
  return sendJson(res, { ok: true, nodeSettings });
}

async function updateServerChanSettings(req, res) {
  const body = await readBodyJson(req);
  config.serverChan = {
    ...(config.serverChan || {}),
    enabled: Boolean(body.enabled),
    cooldownSeconds: Math.max(0, Number(body.cooldownSeconds || 0)),
    subjectPrefix: String(body.subjectPrefix || "[Resource Monitor Alert]")
  };
  await writeJson(CONFIG_PATH, config);

  const envUpdates = {
    SERVERCHAN_SENDKEY: body.sendKey
  };

  for (const [key, value] of Object.entries(envUpdates)) {
    if (value === undefined || value === null) continue;
    process.env[key] = String(value);
    await upsertEnvValue(ENV_PATH, key, String(value));
  }

  await publish();
  return sendJson(res, { ok: true, config, serverChanSettings: getPublicServerChanSettings() });
}

async function runCheck() {
  const checkedAt = new Date().toISOString();
  let snapshot;
  try {
    const response = await fetchTarget(config.target);
    const metrics = extractMetrics(response, config.extractors || []);
    const { resources, hiddenCount, rawCount } = extractResources(response, config.resourceFilter);
    await hydrateResourceMonitorSeries(resources, config.monitorSeries);
    applyNodeSettings(resources, nodeSettings);
    const resourceSummary = summarizeResources(resources);
    metrics.httpStatus = response.statusCode;
    metrics.responseTimeMs = response.responseTimeMs;
    metrics.contentBytes = Buffer.byteLength(response.body || "", "utf8");
    metrics.resourceFetched = resources.length;
    metrics.resourceRaw = rawCount;
    metrics.resourceHidden = hiddenCount;
    metrics.resourceManuallyHidden = resources.filter((item) => item.uiHidden).length;
    metrics.resourceDisplayed = resources.filter((item) => !item.uiHidden).length;
    metrics.totalFlowMbps = resourceSummary.totalFlowMbps;
    metrics.totalBandwidthMbps = resourceSummary.totalBandwidthMbps;
    metrics.bandwidthUsagePercent = resourceSummary.bandwidthUsagePercent;

    snapshot = {
      ok: response.statusCode >= 200 && response.statusCode < 400,
      checkedAt,
      target: { name: config.target.name, url: config.target.url },
      metrics,
      resources,
      sample: compactText(stripHtml(response.body || "")).slice(0, 600)
    };
  } catch (error) {
    snapshot = {
      ok: false,
      checkedAt,
      target: { name: config.target.name, url: config.target.url },
      metrics: {
        httpStatus: 0,
        responseTimeMs: null,
        contentBytes: 0,
        resourceFetched: 0,
        resourceRaw: 0,
        resourceHidden: 0,
        resourceManuallyHidden: 0,
        resourceDisplayed: 0,
        totalFlowMbps: 0,
        totalBandwidthMbps: 0,
        bandwidthUsagePercent: 0,
        error: error.message
      },
      resources: [],
      sample: ""
    };
  }

  const alerts = [
    ...evaluateRules(config.rules || [], snapshot.metrics),
    ...evaluateNodeAlerts(snapshot.resources || [], checkedAt)
  ];
  snapshot.alerts = alerts;
  state.lastRun = checkedAt;
  state.latest = snapshot;
  state.activeAlerts = alerts;
  history = [snapshot, ...history].slice(0, Number(config.schedule?.historyLimit || 100));

  for (const alert of alerts) {
    await maybeSendAlert(alert, snapshot);
  }

  await writeJson(HISTORY_PATH, history);
  await writeJson(STATE_PATH, state);
  await publish();
  return snapshot;
}

async function maybeSendAlert(rule, snapshot) {
  if (!config.serverChan?.enabled) return;
  const cooldownMs = Math.max(0, Number(config.serverChan.cooldownSeconds || 0)) * 1000;
  const lastSent = state.lastEmailByRule?.[rule.id] || 0;
  if (Date.now() - lastSent < cooldownMs) return;
  try {
    await sendServerChanAlert({ rule, metricValue: rule.actual ?? snapshot.metrics[rule.metric], snapshot });
    state.lastEmailByRule = { ...state.lastEmailByRule, [rule.id]: Date.now() };
  } catch (error) {
    console.error(`Server酱推送失败: ${error.message}`);
  }
}

function evaluateRules(rules, metrics) {
  return rules.filter((rule) => {
    if (!rule.enabled) return false;
    const actual = metrics[rule.metric];
    return compare(actual, rule.operator, rule.value);
  }).map((rule) => ({
    ...rule,
    actual: metrics[rule.metric],
    triggeredAt: new Date().toISOString()
  }));
}

function evaluateNodeAlerts(resources, checkedAt) {
  const currentMinute = formatShanghaiMinute(checkedAt);
  const currentDate = formatShanghaiDate(checkedAt);
  const alerts = [];
  state.lastNodeAlertByRule ||= {};

  for (const resource of resources) {
    if (isNodeAlertMuted(resource.alertMute, checkedAt)) continue;
    for (const rule of resource.nodeAlerts || []) {
      if (!rule.enabled || rule.type !== "time_percent_below") continue;
      if (!rule.time || rule.time !== currentMinute) continue;

      const actual = Number(resource.bandwidthUsagePercent || 0);
      const threshold = Number(rule.thresholdPercent || 0);
      if (!(actual < threshold)) continue;

      const minuteKey = `${currentDate} ${rule.time}`;
      const alertKey = `${resource.uuid}:${rule.id}:${minuteKey}`;
      if (state.lastNodeAlertByRule[alertKey]) continue;
      state.lastNodeAlertByRule[alertKey] = checkedAt;

      alerts.push({
        id: alertKey,
        ruleId: rule.id,
        type: rule.type,
        metric: "bandwidthUsagePercent",
        actual,
        thresholdPercent: threshold,
        severity: rule.severity || "warning",
        message: `${resource.remark || resource.uuid} 在 ${rule.time} 流量占比低于 ${threshold}%`,
        triggeredAt: checkedAt,
        nodeUuid: resource.uuid,
        nodeRemark: resource.remark || "",
        nodeStatus: resource.statusLabel || resource.status,
        currentFlowMbps: Number(resource.currentFlowMbps || 0),
        currentFlowLabel: resource.currentFlowLabel || formatMbps(resource.currentFlowMbps || 0),
        bandwidthUsagePercent: Number(resource.bandwidthUsagePercent || 0),
        time: rule.time
      });
    }
  }

  return alerts;
}

function compare(actual, operator, expected) {
  switch (operator) {
    case "equals": return actual === expected;
    case "notEquals": return actual !== expected;
    case "greaterThan": return Number(actual) > Number(expected);
    case "greaterOrEqual": return Number(actual) >= Number(expected);
    case "lessThan": return Number(actual) < Number(expected);
    case "lessOrEqual": return Number(actual) <= Number(expected);
    case "contains": return String(actual ?? "").includes(String(expected ?? ""));
    case "notContains": return !String(actual ?? "").includes(String(expected ?? ""));
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    case "missing": return actual === undefined || actual === null || actual === "";
    default: return false;
  }
}

function extractMetrics(response, extractors) {
  const body = response.body || "";
  const text = compactText(stripHtml(body));
  let json = null;
  if ((response.headers["content-type"] || "").includes("application/json")) {
    try { json = JSON.parse(body); } catch {}
  }

  const metrics = {};
  for (const extractor of extractors) {
    let value = null;
    if (extractor.type === "regex") {
      const match = body.match(new RegExp(extractor.pattern, extractor.flags || ""));
      value = match?.[1] ?? match?.[0] ?? null;
    } else if (extractor.type === "contains") {
      value = text.includes(extractor.needle || "");
    } else if (extractor.type === "textLength") {
      value = text.length;
    } else if (extractor.type === "jsonPath" && json) {
      value = readPath(json, extractor.path);
    }
    metrics[extractor.key] = coerce(value, extractor.valueType);
  }
  return metrics;
}

function extractResources(response, filter = {}) {
  if (!(response.headers["content-type"] || "").includes("application/json")) {
    return { resources: [], hiddenCount: 0, rawCount: 0 };
  }
  let payload;
  try {
    payload = JSON.parse(response.body || "{}");
  } catch {
    return { resources: [], hiddenCount: 0, rawCount: 0 };
  }
  const list = payload?.data?.list;
  if (!Array.isArray(list)) return { resources: [], hiddenCount: 0, rawCount: 0 };

  const includedStatusMaps = Array.isArray(filter.includeMachineStatusMap)
    ? new Set(filter.includeMachineStatusMap)
    : null;
  const excludedStatusMaps = new Set(filter.excludeMachineStatusMap || ["offlineHide"]);
  const visible = list.filter((item) => {
    if (includedStatusMaps) return includedStatusMaps.has(item.machineStatusMap);
    return !excludedStatusMaps.has(item.machineStatusMap);
  });
  return {
    rawCount: list.length,
    hiddenCount: list.length - visible.length,
    resources: visible.map((item) => ({
    status: item.status,
    statusLabel: formatResourceStatus(item.status, item.online, item.machineStatusMap),
    uuid: item.uuid || "",
    currentFlow: item.tx5 ?? item.currentBandwidth ?? 0,
    currentFlowMbps: item.tx5 !== undefined && item.tx5 !== null
      ? monitorTxToMbps(item.tx5)
      : round(Number(item.currentBandwidth || 0), 2),
    currentFlowLabel: formatMbps(item.tx5 !== undefined && item.tx5 !== null
      ? monitorTxToMbps(item.tx5)
      : Number(item.currentBandwidth || 0)),
    currentBandwidth: item.currentBandwidth ?? 0,
    tx5Flow: item.tx5Flow ?? null,
    bandwidthMbps: Number(item.maxBandwidth || 0),
    bandwidthLabel: formatMbps(item.maxBandwidth || 0),
    bandwidthUsagePercent: percent(item.tx5 !== undefined && item.tx5 !== null
      ? monitorTxToMbps(item.tx5)
      : Number(item.currentBandwidth || 0), Number(item.maxBandwidth || 0)),
    remark: item.descSub || "",
    online: item.online,
    host: item.host || "",
    machineStatusMap: item.machineStatusMap || "",
    reportCreateTime: item.reportCreateTime || null
    }))
  };
}

function summarizeResources(resources) {
  const totalFlowMbps = resources.reduce((sum, item) => sum + Number(item.currentFlowMbps || 0), 0);
  const totalBandwidthMbps = resources.reduce((sum, item) => sum + Number(item.bandwidthMbps || 0), 0);
  return {
    totalFlowMbps: round(totalFlowMbps, 2),
    totalBandwidthMbps: round(totalBandwidthMbps, 2),
    bandwidthUsagePercent: percent(totalFlowMbps, totalBandwidthMbps)
  };
}

function applyNodeSettings(resources, settings) {
  const hiddenSet = new Set(settings.hiddenNodeUuids || []);
  const alertsMap = settings.nodeAlerts || {};
  const muteMap = settings.nodeAlertMutes || {};
  const monitorMap = settings.nodeMonitors || {};
  for (const resource of resources) {
    resource.uiHidden = hiddenSet.has(resource.uuid);
    resource.nodeAlerts = alertsMap[resource.uuid] || [];
    resource.alertMute = readActiveNodeMute(muteMap[resource.uuid]);
    resource.monitorSetting = monitorMap[resource.uuid] || null;
  }
  const order = new Map((settings.nodeOrderUuids || []).map((uuid, index) => [uuid, index]));
  resources.sort((left, right) => {
    const leftIndex = order.has(left.uuid) ? order.get(left.uuid) : Number.MAX_SAFE_INTEGER;
    const rightIndex = order.has(right.uuid) ? order.get(right.uuid) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return 0;
  });
}

function readActiveNodeMute(mute, now = new Date()) {
  if (!mute || typeof mute !== "object") return null;
  if (mute.mode === "permanent") {
    return {
      mode: "permanent",
      until: null,
      updatedAt: mute.updatedAt || null
    };
  }
  if (mute.mode === "until" && mute.until) {
    const untilMs = Date.parse(mute.until);
    if (Number.isFinite(untilMs) && untilMs > now.getTime()) {
      return {
        mode: "until",
        until: new Date(untilMs).toISOString(),
        updatedAt: mute.updatedAt || null
      };
    }
  }
  return null;
}

function isNodeAlertMuted(mute, checkedAt) {
  return Boolean(readActiveNodeMute(mute, new Date(checkedAt)));
}

function formatResourceStatus(status, online, machineStatusMap) {
  if (online === 0) return "离线";
  const labels = {
    1: "运行中",
    2: "离线",
    3: "部署中",
    4: "删除中",
    5: "已删除",
    6: "未真实部署",
    31: "磁盘未挂载",
    32: "连接失败",
    34: "业务启动失败",
    35: "部署超时",
    39: "网络异常",
    40: "磁盘空间不足"
  };
  return labels[status] || machineStatusMap || `状态 ${status ?? "-"}`;
}

function formatBandwidth(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `${number.toLocaleString("zh-CN")} Mbps`;
}

function formatMbps(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "-";
  return `${number.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} Mbps`;
}

function monitorTxToMbps(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return round((number * 8) / 1000000, 2);
}

function percent(value, total) {
  const number = Number(value || 0);
  const denominator = Number(total || 0);
  if (!Number.isFinite(number) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return round((number / denominator) * 100, 2);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function coerce(value, type) {
  if (type === "number") return Number(value ?? 0);
  if (type === "boolean") {
    if (typeof value === "string") return value.toLowerCase() === "true";
    return Boolean(value);
  }
  if (typeof value === "string") return decodeEntities(compactText(value));
  return value;
}

function readPath(input, keyPath = "") {
  return keyPath.split(".").filter(Boolean).reduce((acc, key) => acc?.[key], input);
}

async function fetchTarget(target) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(target.timeoutMs || 15000));
  const headers = {
    ...(target.headers || {}),
    ...(target.body ? { "Content-Type": "application/json" } : {}),
    ...(process.env.MONITOR_COOKIE ? { Cookie: process.env.MONITOR_COOKIE } : {}),
    ...(process.env.MONITOR_USER_AGENT ? { "User-Agent": process.env.MONITOR_USER_AGENT } : {})
  };

  try {
    const response = await fetch(target.url, {
      method: target.method || "GET",
      headers,
      body: target.body ? JSON.stringify(target.body) : undefined,
      signal: controller.signal,
      redirect: "follow"
    });
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
      responseTimeMs: Date.now() - started
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function hydrateResourceMonitorSeries(resources, options = {}) {
  if (!options.enabled || !resources.length) return;
  const endTime = new Date();
  const startTime = new Date(Date.now() - Math.max(5, Number(options.lookbackMinutes || 60)) * 60 * 1000);
  await Promise.all(resources.map(async (resource) => {
    try {
      const series = await fetchResourceMonitorSeries(resource.uuid, startTime, endTime, options);
      if (!series.length) return;
      resource.flowSeries = series;
      resource.currentFlowMbps = series[series.length - 1].flowMbps;
      resource.currentFlowLabel = formatMbps(resource.currentFlowMbps);
      resource.bandwidthUsagePercent = percent(resource.currentFlowMbps, resource.bandwidthMbps);
    } catch (error) {
      resource.monitorError = error.message;
    }
  }));
}

async function fetchResourceMonitorSeries(uuid, startTime, endTime, options = {}) {
  const url = new URL(`https://cloud.tingyutech.com/api/jusha/machine/monitor/${encodeURIComponent(uuid)}`);
  url.searchParams.set("startTime", startTime.toISOString());
  url.searchParams.set("endTime", endTime.toISOString());
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Referer": "https://cloud.tingyutech.com/jusha/resource/all",
      ...(process.env.MONITOR_COOKIE ? { Cookie: process.env.MONITOR_COOKIE } : {}),
      ...(process.env.MONITOR_USER_AGENT ? { "User-Agent": process.env.MONITOR_USER_AGENT } : {})
    }
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `monitor api ${response.status}`);
  }
  return normalizeMonitorSeries(payload.data ?? payload, Number(options.maxPoints || 30));
}

function normalizeMonitorSeries(payload, maxPoints) {
  const arrays = [];
  collectObjectArrays(payload, arrays);
  const candidates = arrays
    .map((items) => toFlowSeries(items))
    .filter((items) => items.length);
  if (!candidates.length) return [];
  const best = candidates.sort((a, b) => b.length - a.length)[0];
  return best.slice(-Math.max(1, maxPoints));
}

function collectObjectArrays(value, arrays) {
  if (Array.isArray(value)) {
    if (value.some((item) => item && typeof item === "object" && !Array.isArray(item))) {
      arrays.push(value);
    }
    for (const item of value) collectObjectArrays(item, arrays);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectObjectArrays(child, arrays);
  }
}

function toFlowSeries(items) {
  return items
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const monitorTx = readFirstNumber(item, ["tx5", "tx5a", "ipv4tx5", "udpTx5", "networkRx5"]);
      const flow = monitorTx !== null ? monitorTxToMbps(monitorTx) : readFirstNumber(item, [
        "bandwidth",
        "currentBandwidth",
        "currentBandwidthMbps",
        "networkSpeed",
        "speed",
        "value",
        "y",
        "flow"
      ]);
      if (flow === null) return null;
      return {
        checkedAt: String(readFirstValue(item, ["createTime", "time", "timestamp", "date", "createdAt", "reportCreateTime"]) ?? index),
        flowMbps: round(flow, 2)
      };
    })
    .filter(Boolean);
}

function readFirstNumber(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  for (const [key, value] of Object.entries(item)) {
    if (!/(bandwidth|speed|flow|value|bps|Mbps)/i.test(key)) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function readFirstValue(item, keys) {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
  }
  return null;
}

async function loginTargetSite({ username, password }) {
  const started = Date.now();
  const response = await fetch("https://cloud.tingyutech.com/api/basic/login", {
    method: "POST",
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Content-Type": "application/json",
      "Referer": "https://cloud.tingyutech.com/login",
      "User-Agent": process.env.MONITOR_USER_AGENT || defaultUserAgent()
    },
    body: JSON.stringify({ username, password })
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = normalizeSetCookie(setCookie);

  return {
    success: response.ok && payload.success === true && Boolean(cookie),
    status: response.status,
    message: payload.message || text || response.statusText,
    cookie,
    responseTimeMs: Date.now() - started
  };
}

function normalizeSetCookie(setCookie) {
  return setCookie
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((part) => part.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function defaultUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
}

async function sendAlertEmail({ rule, metricValue, snapshot }, force = false) {
  const smtp = readSmtpEnv();
  if (!force && !config.email?.enabled) return;
  if (!smtp.host || !smtp.from || !smtp.to) {
    throw new Error("SMTP 未配置完整，请检查 .env.example 中的 SMTP_HOST、ALERT_FROM、ALERT_TO");
  }

  const subject = `${config.email?.subjectPrefix || "[报警]"} ${rule.message}`;
  const body = [
    `规则: ${rule.id}`,
    `级别: ${rule.severity || "warning"}`,
    `目标: ${snapshot.target.name} ${snapshot.target.url}`,
    `时间: ${snapshot.checkedAt}`,
    `指标: ${rule.metric || "test"} = ${metricValue}`,
    "",
    "当前指标:",
    JSON.stringify(snapshot.metrics || {}, null, 2),
    "",
    "页面片段:",
    snapshot.sample || "(无)"
  ].join("\r\n");

  await smtpSend({
    ...smtp,
    subject,
    body
  });
}

async function sendServerChanAlert({ rule, metricValue, snapshot }, force = false) {
  if (!force && !config.serverChan?.enabled) return;
  const sendKey = process.env.SERVERCHAN_SENDKEY;
  if (!sendKey) {
    throw new Error("Server酱 SendKey 未配置");
  }

  const title = `${config.serverChan?.subjectPrefix || "[报警]"} ${rule.message}`;
  const desp = rule.nodeUuid
    ? buildNodeServerChanMessage(rule, snapshot)
    : buildGenericServerChanMessage(rule, metricValue, snapshot);

  const url = `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title, desp }).toString()
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  if (!response.ok || (payload.code !== undefined && Number(payload.code) !== 0)) {
    throw new Error(payload.message || payload.info || text || `Server酱推送失败 ${response.status}`);
  }
}

function buildNodeServerChanMessage(rule, snapshot) {
  const currentFlow = rule.currentFlowLabel || formatMbps(rule.currentFlowMbps || 0);
  const ruleText = formatNodeAlertRule(rule);
  return [
    `### 聚沙节点报警`,
    "",
    `- 节点名称: ${rule.nodeRemark || rule.nodeUuid}`,
    `- 报警规则: ${ruleText}`,
    `- 目前流量: ${currentFlow}`,
    `- 当前占比: ${formatPercentText(rule.bandwidthUsagePercent ?? rule.actual)}%`,
    `- 报警时间: ${snapshot.checkedAt}`,
    `- UUID: ${rule.nodeUuid}`,
    "",
    `原始消息: ${rule.message}`
  ].join("\n");
}

function buildGenericServerChanMessage(rule, metricValue, snapshot) {
  return [
    `### ${rule.message}`,
    "",
    `- 规则: ${rule.id}`,
    `- 级别: ${rule.severity || "warning"}`,
    `- 目标: ${snapshot.target.name}`,
    `- 时间: ${snapshot.checkedAt}`,
    `- 指标: ${rule.metric || "test"} = ${metricValue}`,
    "",
    "#### 当前指标",
    "```json",
    JSON.stringify(snapshot.metrics || {}, null, 2),
    "```"
  ].join("\n");
}

function formatNodeAlertRule(rule) {
  if (rule.type === "time_percent_below") {
    return `${rule.time || "--:--"} 流量占比低于 ${formatPercentText(rule.thresholdPercent)}%`;
  }
  return rule.message || rule.ruleId || rule.id;
}

function formatPercentText(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function readSmtpEnv() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.ALERT_FROM || process.env.SMTP_USER,
    to: process.env.ALERT_TO
  };
}

async function smtpSend(options) {
  const socket = options.secure
    ? tls.connect(options.port, options.host, { servername: options.host })
    : net.connect(options.port, options.host);

  const read = createLineReader(socket);
  const command = async (line, expected = /^2|^3/) => {
    if (line) socket.write(`${line}\r\n`);
    const response = await read();
    if (!expected.test(response)) throw new Error(`SMTP command failed: ${line || "connect"} -> ${response}`);
    return response;
  };

  await command(null);
  await command(`EHLO ${options.host}`);
  if (!options.secure && options.port === 587) {
    await command("STARTTLS", /^220/);
    const secureSocket = tls.connect({ socket, servername: options.host });
    return smtpSendOverSocket(secureSocket, options, true);
  }
  await smtpSendOverSocket(socket, options, false);
}

async function smtpSendOverSocket(socket, options, skipGreeting) {
  const read = createLineReader(socket);
  const command = async (line, expected = /^2|^3/) => {
    if (line) socket.write(`${line}\r\n`);
    const response = await read();
    if (!expected.test(response)) throw new Error(`SMTP command failed: ${line || "connect"} -> ${response}`);
    return response;
  };

  if (!skipGreeting) await command(null);
  await command(`EHLO ${options.host}`);
  if (options.user && options.pass) {
    await command("AUTH LOGIN", /^334/);
    await command(Buffer.from(options.user).toString("base64"), /^334/);
    await command(Buffer.from(options.pass).toString("base64"));
  }
  await command(`MAIL FROM:<${options.from}>`);
  for (const recipient of String(options.to).split(",").map((item) => item.trim()).filter(Boolean)) {
    await command(`RCPT TO:<${recipient}>`);
  }
  await command("DATA", /^354/);
  socket.write(buildEmailMessage(options));
  await command(".", /^250/);
  await command("QUIT", /^221|^250/);
  socket.end();
}

function createLineReader(socket) {
  let buffer = "";
  const queue = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    queue.push(...lines.filter(Boolean));
  });
  socket.on("error", (error) => queue.push(`500 ${error.message}`));
  return async function readLine() {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      if (queue.length) {
        let line = queue.shift();
        while (/^\d{3}-/.test(line) && queue.length) line = queue.shift();
        return line;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("SMTP response timeout");
  };
}

function buildEmailMessage({ from, to, subject, body }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body
  ].join("\r\n");
}

async function serveStatic(req, res) {
  const requested = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested === "/" ? "index.html" : requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, "Forbidden", 403);
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  } catch {
    sendText(res, "Not found", 404);
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  clients.add(res);
  res.write(`data: ${JSON.stringify(getPublicState())}\n\n`);
  req.on("close", () => clients.delete(res));
}

async function publish() {
  const payload = `data: ${JSON.stringify(getPublicState())}\n\n`;
  for (const client of clients) client.write(payload);
}

function getPublicState() {
  return {
    state,
    config,
    history,
    nodeSettings,
    serverChanSettings: getPublicServerChanSettings(),
    auth: {
      hasCookie: Boolean(process.env.MONITOR_COOKIE),
      cookieLength: process.env.MONITOR_COOKIE?.length || 0
    }
  };
}

function getPublicEmailSettings() {
  const smtp = readSmtpEnv();
  return {
    enabled: Boolean(config.email?.enabled),
    cooldownSeconds: Number(config.email?.cooldownSeconds || 0),
    subjectPrefix: config.email?.subjectPrefix || "[Resource Monitor Alert]",
    smtpHost: smtp.host || "",
    smtpPort: smtp.port || 587,
    smtpSecure: Boolean(smtp.secure),
    smtpUser: smtp.user || "",
    hasSmtpPass: Boolean(smtp.pass),
    alertFrom: smtp.from || "",
    alertTo: smtp.to || ""
  };
}

function getPublicServerChanSettings() {
  return {
    enabled: Boolean(config.serverChan?.enabled),
    cooldownSeconds: Number(config.serverChan?.cooldownSeconds || 0),
    subjectPrefix: config.serverChan?.subjectPrefix || "[Resource Monitor Alert]",
    hasSendKey: Boolean(process.env.SERVERCHAN_SENDKEY),
    sendKeyPreview: maskSecret(process.env.SERVERCHAN_SENDKEY || "")
  };
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadEnv(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env is optional; production can inject environment variables directly.
  }
}

async function upsertEnvValue(filePath, key, value) {
  let lines = [];
  try {
    lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
  } catch {}

  const escaped = String(value).replace(/\r?\n/g, "");
  let found = false;
  lines = lines.map((line) => {
    const index = line.indexOf("=");
    if (index === -1 || line.trim().startsWith("#")) return line;
    if (line.slice(0, index).trim() !== key) return line;
    found = true;
    return `${key}=${escaped}`;
  }).filter((line, index, arr) => line !== "" || index < arr.length - 1);

  if (!found) lines.push(`${key}=${escaped}`);
  await fs.writeFile(filePath, `${lines.join("\n").trim()}\n`, "utf8");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function persistNodeSettings() {
  nodeSettings = normalizeNodeSettings(nodeSettings);
  await writeJson(NODE_SETTINGS_PATH, nodeSettings);
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validateConfig(next) {
  if (!next?.target?.url) throw new Error("target.url is required");
  new URL(next.target.url);
  if (!Array.isArray(next.extractors)) throw new Error("extractors must be an array");
  if (!Array.isArray(next.rules)) throw new Error("rules must be an array");
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function compactText(text) {
  return decodeEntities(String(text || "").replace(/\s+/g, " ").trim());
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeNodeSettings(value = {}) {
  const hiddenNodeUuids = Array.isArray(value.hiddenNodeUuids)
    ? [...new Set(value.hiddenNodeUuids.filter(Boolean).map(String))]
    : [];
  const nodeOrderUuids = Array.isArray(value.nodeOrderUuids)
    ? [...new Set(value.nodeOrderUuids.filter(Boolean).map(String))]
    : [];
  const nodeAlerts = {};
  for (const [uuid, rules] of Object.entries(value.nodeAlerts || {})) {
    const normalized = normalizeNodeAlertRules(rules, uuid);
    if (normalized.length) nodeAlerts[uuid] = normalized;
  }
  const nodeAlertMutes = {};
  for (const [uuid, mute] of Object.entries(value.nodeAlertMutes || {})) {
    const normalized = readActiveNodeMute(mute);
    if (normalized) nodeAlertMutes[uuid] = normalized;
  }
  const nodeMonitors = {};
  for (const [uuid, monitor] of Object.entries(value.nodeMonitors || {})) {
    const normalized = normalizeNodeMonitorSetting(monitor);
    if (normalized) nodeMonitors[uuid] = normalized;
  }
  return { hiddenNodeUuids, nodeOrderUuids, nodeAlerts, nodeAlertMutes, nodeMonitors };
}

function normalizeNodeMonitorSetting(monitor) {
  if (!monitor || typeof monitor !== "object") return null;
  const startTime = normalizeHm(monitor.startTime);
  const endTime = normalizeHm(monitor.endTime);
  const expectedFlowMbps = Number(monitor.expectedFlowMbps ?? monitor.expected ?? 0);
  if (!startTime || !endTime || !Number.isFinite(expectedFlowMbps) || expectedFlowMbps < 0) return null;
  return {
    enabled: monitor.enabled !== false,
    startTime,
    endTime,
    expectedFlowMbps: round(expectedFlowMbps, 2)
  };
}

function normalizeNodeAlertRules(rules, uuid) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule, index) => normalizeNodeAlertRule(rule, uuid, index))
    .filter(Boolean);
}

function normalizeNodeAlertRule(rule, uuid, index) {
  if (!rule || typeof rule !== "object") return null;
  const type = rule.type || "time_percent_below";
  if (type !== "time_percent_below") return null;
  const thresholdPercent = Number(rule.thresholdPercent ?? rule.threshold ?? 0);
  return {
    id: String(rule.id || `${uuid}-${type}-${index + 1}`),
    type,
    enabled: rule.enabled !== false,
    severity: rule.severity || "warning",
    time: normalizeHm(rule.time) || "00:00",
    thresholdPercent: Number.isFinite(thresholdPercent) ? round(thresholdPercent, 2) : 0
  };
}

function normalizeHm(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatShanghaiMinute(value) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  }).format(new Date(value));
}

function formatShanghaiDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Shanghai"
  }).format(new Date(value));
}
