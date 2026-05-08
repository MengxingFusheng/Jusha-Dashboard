const els = {
  targetLabel: document.querySelector("#targetLabel"),
  runStatus: document.querySelector("#runStatus"),
  lastRun: document.querySelector("#lastRun"),
  alertCount: document.querySelector("#alertCount"),
  serverChanBadge: document.querySelector("#serverChanBadge"),
  alertLogs: document.querySelector("#alertLogs"),
  resources: document.querySelector("#resources"),
  resourceCount: document.querySelector("#resourceCount"),
  hiddenMenu: document.querySelector("#hiddenMenu"),
  saveMessage: document.querySelector("#saveMessage"),
  cookieBadge: document.querySelector("#cookieBadge"),
  loginForm: document.querySelector("#loginForm"),
  loginUsername: document.querySelector("#loginUsername"),
  loginPassword: document.querySelector("#loginPassword"),
  loginButton: document.querySelector("#loginButton"),
  loginMessage: document.querySelector("#loginMessage"),
  checkNow: document.querySelector("#checkNow"),
  intervalSeconds: document.querySelector("#intervalSeconds"),
  testServerChan: document.querySelector("#testServerChan"),
  nodeAlertPanel: document.querySelector("#nodeAlertPanel"),
  selectedNodeLabel: document.querySelector("#selectedNodeLabel"),
  nodeAlertList: document.querySelector("#nodeAlertList"),
  nodeAlertMessage: document.querySelector("#nodeAlertMessage"),
  addNodeAlert: document.querySelector("#addNodeAlert"),
  saveNodeAlerts: document.querySelector("#saveNodeAlerts"),
  serverChanForm: document.querySelector("#serverChanForm"),
  serverChanEnabled: document.querySelector("#serverChanEnabled"),
  serverChanSendKey: document.querySelector("#serverChanSendKey"),
  subjectPrefix: document.querySelector("#subjectPrefix"),
  cooldownSeconds: document.querySelector("#cooldownSeconds"),
  saveServerChanSettings: document.querySelector("#saveServerChanSettings"),
  serverChanMessage: document.querySelector("#serverChanMessage")
};

let latestPayload = null;
let selectedNodeUuid = "";
let draftNodeAlerts = [];
let serverChanFormDirty = false;
let draggedUuid = "";
let flippedTileUuid = "";
let flippedTileMode = "alert";
const tileAlertDrafts = new Map();
const tileMonitorDrafts = new Map();
const nodeChartHoverPoints = new Map();
const dismissedNodeAlertIds = new Set(readDismissedNodeAlertIds());

els.checkNow.addEventListener("click", () => runAction("/api/check", els.checkNow, "检查完成"));
els.intervalSeconds.addEventListener("change", saveSamplingInterval);
els.testServerChan.addEventListener("click", () => runAction("/api/test-serverchan", els.testServerChan, "测试推送已提交", els.serverChanMessage));
els.loginForm.addEventListener("submit", loginAccount);
els.resources.addEventListener("click", onResourceAction);
els.resources.addEventListener("input", onTileAlertInput);
els.resources.addEventListener("input", onTileMonitorInput);
els.resources.addEventListener("dragstart", onResourceDragStart);
els.resources.addEventListener("dragover", onResourceDragOver);
els.resources.addEventListener("dragleave", onResourceDragLeave);
els.resources.addEventListener("drop", onResourceDrop);
els.resources.addEventListener("dragend", onResourceDragEnd);
els.resources.addEventListener("mousemove", onNodeChartHover);
els.resources.addEventListener("mouseleave", hideNodeChartTooltip);
els.hiddenMenu.addEventListener("click", onHiddenMenuAction);
els.addNodeAlert.addEventListener("click", addNodeAlertRule);
els.saveNodeAlerts.addEventListener("click", saveNodeAlerts);
els.nodeAlertList.addEventListener("click", onNodeAlertListClick);
els.nodeAlertList.addEventListener("input", onNodeAlertListInput);
els.serverChanForm.addEventListener("input", () => {
  serverChanFormDirty = true;
});
els.saveServerChanSettings.addEventListener("click", saveServerChanSettings);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".mute-menu-wrap")) closeMuteMenus();
});

const events = new EventSource("/events");
events.onmessage = (event) => render(JSON.parse(event.data));
events.onerror = () => {
  els.runStatus.textContent = "连接中断";
  els.runStatus.className = "badge danger";
};

fetch("/api/state")
  .then((res) => res.json())
  .then(render)
  .catch((error) => {
    els.runStatus.textContent = "读取失败";
    els.runStatus.className = "badge danger";
    els.saveMessage.textContent = error.message;
  });

function render(payload) {
  latestPayload = payload;
  const { state, config, history, auth, nodeSettings, serverChanSettings } = payload;
  const latest = state.latest;
  const metrics = latest?.metrics || {};
  const resources = latest?.resources || [];

  ensureSelectedNode(resources, nodeSettings);

  els.targetLabel.textContent = `${config.target.name} · ${config.target.url}`;
  els.runStatus.textContent = latest?.ok ? "正常" : latest ? "异常" : "等待首检";
  els.runStatus.className = `badge ${latest?.ok ? "ok" : latest ? "danger" : "muted"}`;
  els.lastRun.textContent = latest ? `最近检查 ${formatTime(latest.checkedAt)}` : "最近检查 -";
  els.cookieBadge.textContent = auth?.hasCookie ? `Cookie 已保存 (${auth.cookieLength} 字符)` : "未保存 Cookie";
  els.cookieBadge.className = `badge ${auth?.hasCookie ? "ok" : "muted"}`;
  els.serverChanBadge.textContent = config.serverChan?.enabled ? "推送已启用" : "推送未启用";
  els.serverChanBadge.className = `badge ${config.serverChan?.enabled ? "ok" : "muted"}`;
  renderSamplingInterval(config);

  syncDismissedNodeAlerts(state.activeAlerts || []);
  renderResources(resources, metrics, history || [], nodeSettings || {}, state.activeAlerts || []);
  renderHiddenMenu(resources, nodeSettings);
  renderNodeAlertPanel(resources, nodeSettings);
  renderAlertLogs(state.activeAlerts || [], history || []);
  renderServerChanSettings(serverChanSettings || {});
}

function ensureSelectedNode(resources, nodeSettings = {}) {
  if (selectedNodeUuid && resources.some((item) => item.uuid === selectedNodeUuid)) return;
  const firstVisible = resources.find((item) => !item.uiHidden);
  const firstAny = resources[0];
  selectedNodeUuid = firstVisible?.uuid || firstAny?.uuid || "";
  draftNodeAlerts = cloneAlerts(nodeSettings?.nodeAlerts?.[selectedNodeUuid] || []);
}

function renderResources(resources, metrics = {}, history = [], nodeSettings = {}, activeAlerts = []) {
  const visibleResources = sortResources(resources.filter((item) => !item.uiHidden), nodeSettings);
  const manualHidden = Number(metrics.resourceManuallyHidden || 0);
  els.resourceCount.textContent = `展示 ${visibleResources.length} 条 · 手动隐藏 ${manualHidden} 条 · 站点排除 ${Number(metrics.resourceHidden || 0)} 条`;

  const series = buildNodeSeries(history);
  const activeAlertsByNode = groupActiveAlertsByNode(activeAlerts);
  nodeChartHoverPoints.clear();
  els.resources.innerHTML = visibleResources.length ? visibleResources.map((item) => {
    const points = series.get(item.uuid) || [];
    const alertCount = (item.nodeAlerts || []).length;
    const activeNodeAlerts = activeAlertsByNode.get(item.uuid) || [];
    const mute = getActiveNodeMute(item.uuid, nodeSettings);
    const muteActive = Boolean(mute);
    nodeChartHoverPoints.set(item.uuid, getNodeChartHoverPoints(points, item));
    return `
      <article class="resource-tile ${flippedTileUuid === item.uuid ? "is-flipped" : ""}" draggable="${flippedTileUuid === item.uuid ? "false" : "true"}" data-uuid="${escapeHtml(item.uuid)}">
        ${activeNodeAlerts.length ? `
          <button type="button" class="tile-alert-button" data-action="dismiss-node-alert" data-uuid="${escapeHtml(item.uuid)}" title="消除当前节点报警提示" aria-label="消除当前节点报警提示">
            &#128276;
            <span>${activeNodeAlerts.length}</span>
          </button>
        ` : ""}
        <button type="button" class="tile-hide-button" data-action="hide-node" data-uuid="${escapeHtml(item.uuid)}" title="隐藏节点" aria-label="隐藏节点">×</button>
        <div class="resource-tile-head">
          <div>
            <div class="node-title-row">
              <span class="drag-handle" title="拖动排序">≡</span>
              <strong>${escapeHtml(item.remark || "未命名节点")}</strong>
            </div>
            <button type="button" class="uuid-button" data-action="copy-uuid" data-uuid="${escapeHtml(item.uuid)}" title="复制真实 UUID">UUID</button>
          </div>
          <div class="tile-head-side">
            <span class="status-pill ${item.online === 0 ? "offline" : "online"}">${escapeHtml(item.statusLabel || item.status)}</span>
            <div class="tile-actions">
              <div class="mute-menu-wrap">
                <button type="button" class="icon-button mute-button ${muteActive ? "active" : ""}" data-action="toggle-mute-menu" data-uuid="${escapeHtml(item.uuid)}" title="${escapeHtml(formatMuteTitle(mute))}" aria-label="${escapeHtml(formatMuteTitle(mute))}">
                  &#128277;
                </button>
                <div class="mute-menu" role="menu">
                  <button type="button" class="mute-option" data-action="mute-alerts" data-duration="1h" data-uuid="${escapeHtml(item.uuid)}">禁用 1 小时</button>
                  <button type="button" class="mute-option" data-action="mute-alerts" data-duration="24h" data-uuid="${escapeHtml(item.uuid)}">禁用 24 小时</button>
                  <button type="button" class="mute-option" data-action="mute-alerts" data-duration="forever" data-uuid="${escapeHtml(item.uuid)}">永久禁用</button>
                  ${muteActive ? `<button type="button" class="mute-option restore" data-action="mute-alerts" data-duration="none" data-uuid="${escapeHtml(item.uuid)}">解除禁用</button>` : ""}
                </div>
              </div>
              <button type="button" class="icon-button monitor-button" data-action="configure-monitor" data-uuid="${escapeHtml(item.uuid)}" title="监控预期" aria-label="监控预期">
                ◔
              </button>
              <button type="button" class="icon-button gear-button" data-action="configure-alerts" data-uuid="${escapeHtml(item.uuid)}" title="报警设置" aria-label="报警设置">
                ⚙
                ${alertCount ? `<span class="alert-count-badge">${alertCount}</span>` : ""}
              </button>
            </div>
          </div>
        </div>
        <div class="resource-stats">
          <div><strong>${escapeHtml(formatNumber(item.currentFlowMbps))}<span>Mbps</span></strong></div>
          <div><strong>${escapeHtml(formatNumber(item.bandwidthUsagePercent))}<span>%</span></strong></div>
        </div>
        <div class="node-chart-wrap">
          <svg class="node-chart" viewBox="0 0 360 150" role="img" aria-label="${escapeHtml(item.remark || item.uuid || "节点")}流量曲线">
            ${renderNodeChart(points, item)}
          </svg>
          <div class="chart-tooltip" aria-hidden="true"></div>
        </div>
        <div class="tile-alert-back">
          ${flippedTileMode === "monitor" ? renderTileMonitorSettings(item) : renderTileAlertSettings(item)}
        </div>
      </article>
    `;
  }).join("") : `<div class="empty-tile">当前没有可展示节点</div>`;
}

function renderHiddenMenu(resources, nodeSettings = {}) {
  const hiddenUuids = new Set(nodeSettings.hiddenNodeUuids || []);
  const hiddenResources = sortResources(resources.filter((item) => hiddenUuids.has(item.uuid)), nodeSettings);
  if (!hiddenResources.length) {
    els.hiddenMenu.innerHTML = `<span class="badge muted">已隐藏 0 条</span>`;
    return;
  }

  els.hiddenMenu.innerHTML = `
    <details class="hidden-dropdown">
      <summary class="hidden-summary">已隐藏 ${hiddenResources.length} 条</summary>
      <div class="hidden-dropdown-body">
        ${hiddenResources.map((item) => `
          <div class="hidden-node-row">
            <div>
              <strong>${escapeHtml(item.remark || "未命名节点")}</strong>
              <button type="button" class="uuid-button small" data-action="copy-uuid" data-uuid="${escapeHtml(item.uuid)}" title="复制真实 UUID">UUID</button>
            </div>
            <button type="button" class="ghost-button" data-action="unhide-node" data-uuid="${escapeHtml(item.uuid)}">解除隐藏</button>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function renderNodeAlertPanel(resources, nodeSettings = {}) {
  const resource = resources.find((item) => item.uuid === selectedNodeUuid);
  if (!resource) {
    els.selectedNodeLabel.textContent = "请选择一个节点";
    els.nodeAlertList.innerHTML = `<div class="empty">还没有可配置的节点</div>`;
    return;
  }

  const storedAlerts = nodeSettings.nodeAlerts?.[resource.uuid] || [];
  if (!draftNodeAlerts.length && storedAlerts.length) draftNodeAlerts = cloneAlerts(storedAlerts);

  els.selectedNodeLabel.textContent = `${resource.remark || "未命名节点"} · UUID 已隐藏`;
  els.nodeAlertList.innerHTML = draftNodeAlerts.length ? draftNodeAlerts.map((rule, index) => `
    <article class="alert-rule-card" data-index="${index}">
      <div class="alert-rule-head">
        <div>
          <strong>报警类型 1</strong>
          <span>指定时间流量占比低于阈值</span>
        </div>
        <button type="button" class="ghost-button danger" data-action="remove-alert-rule" data-index="${index}">删除</button>
      </div>
      <div class="alert-rule-grid">
        <label class="switch-row">
          <span>启用</span>
          <input type="checkbox" data-field="enabled" data-index="${index}" ${rule.enabled ? "checked" : ""}>
        </label>
        <label>
          <span>时间点</span>
          <input type="time" data-field="time" data-index="${index}" value="${escapeHtml(rule.time || "00:00")}">
        </label>
        <label>
          <span>低于百分比触发</span>
          <input type="number" min="0" max="999" step="0.01" data-field="thresholdPercent" data-index="${index}" value="${escapeHtml(String(rule.thresholdPercent ?? 0))}">
        </label>
      </div>
    </article>
  `).join("") : `<div class="empty">当前节点还没有报警规则，点“新增报警”即可添加。</div>`;
}

function renderTileAlertSettings(resource) {
  const rules = getTileAlertDraft(resource.uuid, resource.nodeAlerts || []);
  return `
    <div class="tile-alert-settings">
      <div class="tile-alert-settings-head">
        <div>
          <strong>${escapeHtml(resource.remark || "未命名节点")}</strong>
          <span>报警设置</span>
        </div>
        <button type="button" class="icon-button" data-action="close-tile-alerts" data-uuid="${escapeHtml(resource.uuid)}" title="返回监控" aria-label="返回监控">×</button>
      </div>
      <div class="tile-alert-rules">
        ${rules.length ? rules.map((rule, index) => renderTileAlertRule(rule, index, resource.uuid)).join("") : `<div class="empty compact-empty">当前节点还没有报警规则</div>`}
      </div>
      <div class="tile-alert-footer">
        <button type="button" class="ghost-button" data-action="add-tile-alert-rule" data-uuid="${escapeHtml(resource.uuid)}">新增规则</button>
        <button type="button" data-action="save-tile-alerts" data-uuid="${escapeHtml(resource.uuid)}">保存</button>
      </div>
    </div>
  `;
}

function renderTileMonitorSettings(resource) {
  const monitor = getTileMonitorDraft(resource.uuid, resource.monitorSetting);
  return `
    <div class="tile-alert-settings">
      <div class="tile-alert-settings-head">
        <div>
          <strong>${escapeHtml(resource.remark || "未命名节点")}</strong>
          <span>监控预期</span>
        </div>
        <button type="button" class="icon-button" data-action="close-tile-alerts" data-uuid="${escapeHtml(resource.uuid)}" title="返回监控" aria-label="返回监控">×</button>
      </div>
      <div class="tile-monitor-form">
        <label class="switch-row">
          <span>启用</span>
          <input type="checkbox" data-monitor-field="enabled" data-uuid="${escapeHtml(resource.uuid)}" ${monitor.enabled ? "checked" : ""}>
        </label>
        <label>
          <span>开始时间</span>
          <input type="time" data-monitor-field="startTime" data-uuid="${escapeHtml(resource.uuid)}" value="${escapeHtml(monitor.startTime)}">
        </label>
        <label>
          <span>结束时间</span>
          <input type="time" data-monitor-field="endTime" data-uuid="${escapeHtml(resource.uuid)}" value="${escapeHtml(monitor.endTime)}">
        </label>
        <label>
          <span>预期流量 Mbps</span>
          <input type="number" min="0" step="0.01" data-monitor-field="expectedFlowMbps" data-uuid="${escapeHtml(resource.uuid)}" value="${escapeHtml(String(monitor.expectedFlowMbps ?? 0))}">
        </label>
        <div class="monitor-color-guide">
          <span><i class="guide-blue"></i>达标</span>
          <span><i class="guide-yellow"></i>低于 10% 内</span>
          <span><i class="guide-red"></i>低于 10% 以上</span>
        </div>
      </div>
      <div class="tile-alert-footer">
        <button type="button" class="ghost-button danger" data-action="clear-tile-monitor" data-uuid="${escapeHtml(resource.uuid)}">清除</button>
        <button type="button" data-action="save-tile-monitor" data-uuid="${escapeHtml(resource.uuid)}">保存</button>
      </div>
    </div>
  `;
}

function renderTileAlertRule(rule, index, uuid) {
  return `
    <article class="tile-alert-rule" data-uuid="${escapeHtml(uuid)}" data-index="${index}">
      <div class="tile-alert-rule-head">
        <strong>类型 1</strong>
        <button type="button" class="ghost-button danger" data-action="remove-tile-alert-rule" data-uuid="${escapeHtml(uuid)}" data-index="${index}">删除</button>
      </div>
      <label class="switch-row">
        <span>启用</span>
        <input type="checkbox" data-tile-alert-field="enabled" data-uuid="${escapeHtml(uuid)}" data-index="${index}" ${rule.enabled ? "checked" : ""}>
      </label>
      <label>
        <span>时间点</span>
        <input type="time" data-tile-alert-field="time" data-uuid="${escapeHtml(uuid)}" data-index="${index}" value="${escapeHtml(rule.time || "00:00")}">
      </label>
      <label>
        <span>流量占比低于</span>
        <input type="number" min="0" max="999" step="0.01" data-tile-alert-field="thresholdPercent" data-uuid="${escapeHtml(uuid)}" data-index="${index}" value="${escapeHtml(String(rule.thresholdPercent ?? 0))}">
      </label>
    </article>
  `;
}

function getTileAlertDraft(uuid, storedAlerts = []) {
  if (!tileAlertDrafts.has(uuid)) tileAlertDrafts.set(uuid, cloneAlerts(storedAlerts));
  return tileAlertDrafts.get(uuid);
}

function getTileMonitorDraft(uuid, storedMonitor = null) {
  if (!tileMonitorDrafts.has(uuid)) {
    tileMonitorDrafts.set(uuid, {
      enabled: storedMonitor?.enabled !== false,
      startTime: storedMonitor?.startTime || "00:00",
      endTime: storedMonitor?.endTime || "23:59",
      expectedFlowMbps: Number(storedMonitor?.expectedFlowMbps || 0)
    });
  }
  return tileMonitorDrafts.get(uuid);
}

function renderAlertLogs(activeAlerts, history) {
  const logs = [
    ...activeAlerts.map((item) => ({ ...item, live: true })),
    ...history.flatMap((snapshot) => (snapshot.alerts || []).map((alert) => ({
      ...alert,
      snapshotAt: snapshot.checkedAt,
      live: false
    })))
  ].slice(0, 60);

  els.alertCount.textContent = `${logs.length} 条`;
  els.alertLogs.innerHTML = logs.length ? logs.map((alert) => `
    <div class="alert ${alert.severity === "critical" ? "critical" : ""}">
      <strong>${escapeHtml(alert.message || alert.id)}</strong>
      <span>${escapeHtml(alert.nodeRemark || alert.metric || "-")} · ${escapeHtml(formatValue(alert.actual))} · ${escapeHtml(formatTime(alert.triggeredAt || alert.snapshotAt))}</span>
    </div>
  `).join("") : `<div class="empty">暂无报警日志</div>`;
}

function renderServerChanSettings(settings) {
  if (serverChanFormDirty) return;
  els.serverChanEnabled.checked = Boolean(settings.enabled);
  els.serverChanSendKey.value = "";
  els.serverChanSendKey.placeholder = settings.hasSendKey
    ? `已保存 ${settings.sendKeyPreview}，留空则保持原 SendKey`
    : "请输入 Server酱 SendKey";
  els.subjectPrefix.value = settings.subjectPrefix || "[Resource Monitor Alert]";
  els.cooldownSeconds.value = settings.cooldownSeconds ?? 600;
}

function groupActiveAlertsByNode(activeAlerts = []) {
  const groups = new Map();
  for (const alert of activeAlerts) {
    if (!alert.nodeUuid || dismissedNodeAlertIds.has(alert.id)) continue;
    if (!groups.has(alert.nodeUuid)) groups.set(alert.nodeUuid, []);
    groups.get(alert.nodeUuid).push(alert);
  }
  return groups;
}

function syncDismissedNodeAlerts(activeAlerts = []) {
  const activeIds = new Set(activeAlerts.map((alert) => alert.id).filter(Boolean));
  let changed = false;
  for (const id of [...dismissedNodeAlertIds]) {
    if (!activeIds.has(id)) {
      dismissedNodeAlertIds.delete(id);
      changed = true;
    }
  }
  if (changed) writeDismissedNodeAlertIds();
}

function readDismissedNodeAlertIds() {
  try {
    return JSON.parse(localStorage.getItem("dismissedNodeAlertIds") || "[]");
  } catch {
    return [];
  }
}

function writeDismissedNodeAlertIds() {
  localStorage.setItem("dismissedNodeAlertIds", JSON.stringify([...dismissedNodeAlertIds]));
}

function renderSamplingInterval(config = {}) {
  const seconds = String(Math.max(10, Number(config.schedule?.intervalSeconds || 60)));
  if (![...els.intervalSeconds.options].some((option) => option.value === seconds)) {
    const option = document.createElement("option");
    option.value = seconds;
    option.textContent = `${seconds} 秒`;
    els.intervalSeconds.appendChild(option);
  }
  els.intervalSeconds.value = seconds;
}

function getActiveNodeMute(uuid, nodeSettings = {}) {
  const mute = nodeSettings.nodeAlertMutes?.[uuid];
  if (!mute) return null;
  if (mute.mode === "permanent") return mute;
  if (mute.mode === "until" && mute.until && Date.parse(mute.until) > Date.now()) return mute;
  return null;
}

function formatMuteTitle(mute) {
  if (!mute) return "禁用报警";
  if (mute.mode === "permanent") return "报警已永久禁用";
  return `报警禁用至 ${formatTime(mute.until)}`;
}

function closeMuteMenus() {
  for (const wrap of document.querySelectorAll(".mute-menu-wrap.open")) {
    wrap.classList.remove("open");
  }
}

function sortResources(resources, nodeSettings = {}) {
  const order = new Map((nodeSettings.nodeOrderUuids || []).map((uuid, index) => [uuid, index]));
  return [...resources].sort((left, right) => {
    const leftIndex = order.has(left.uuid) ? order.get(left.uuid) : Number.MAX_SAFE_INTEGER;
    const rightIndex = order.has(right.uuid) ? order.get(right.uuid) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return 0;
  });
}

function buildNodeSeries(history) {
  const series = new Map();
  for (const snapshot of [...history].reverse()) {
    for (const resource of snapshot.resources || []) {
      if (!resource.uuid) continue;
      if (!series.has(resource.uuid)) series.set(resource.uuid, []);
      const bucket = series.get(resource.uuid);
      if (Array.isArray(resource.flowSeries) && resource.flowSeries.length) {
        for (const point of resource.flowSeries) {
          bucket.push({
            checkedAt: point.checkedAt || snapshot.checkedAt,
            flow: Number(point.flowMbps || 0),
            bandwidth: Number(resource.bandwidthMbps || 0)
          });
        }
      } else {
        bucket.push({
          checkedAt: snapshot.checkedAt,
          flow: Number(resource.currentFlowMbps || 0),
          bandwidth: Number(resource.bandwidthMbps || 0)
        });
      }
    }
  }
  return series;
}

function renderNodeChart(points, item) {
  const { values, width, height, pad, maxY, currentFlow, bandwidth, xFor, yFor } = getNodeChartModel(points, item);
  const chartTone = getNodeMonitorTone(item);
  const baselineY = height - pad.bottom;
  const flowLine = values.map((point, index) => `${xFor(index)},${yFor(point.flow)}`).join(" ");
  const flowArea = [
    `${xFor(0)},${baselineY}`,
    ...values.map((point, index) => `${xFor(index)},${yFor(point.flow)}`),
    `${xFor(values.length - 1)},${baselineY}`
  ].join(" ");
  const bandwidthLine = values.map((point, index) => `${xFor(index)},${yFor(bandwidth)}`).join(" ");
  const latest = values[values.length - 1];
  const gridLines = [0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = yFor(maxY * ratio);
    return `<line class="mini-grid" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"></line>`;
  }).join("");
  const ticks = buildChartTicks(values, 4);
  return `
    ${gridLines}
    <line class="mini-axis" x1="${pad.left}" y1="${baselineY}" x2="${width - pad.right}" y2="${baselineY}"></line>
    <polyline class="mini-line mini-bandwidth" points="${bandwidthLine}"></polyline>
    <polygon class="mini-area ${chartTone}" points="${flowArea}"></polygon>
    <polyline class="mini-line mini-flow ${chartTone}" points="${flowLine}"></polyline>
    <circle class="mini-dot" cx="${xFor(values.length - 1)}" cy="${yFor(latest.flow)}" r="4"></circle>
    <text class="mini-label" x="${pad.left}" y="14">100% = ${escapeSvg(formatNumber(bandwidth))} Mbps</text>
    <text class="mini-label end" x="${width - pad.right}" y="14">${escapeSvg(formatNumber(currentFlow))} Mbps · ${escapeSvg(formatPercent(item.bandwidthUsagePercent))}</text>
    ${ticks.map((tick) => `
      <line class="mini-tick" x1="${xFor(tick.index)}" y1="${baselineY}" x2="${xFor(tick.index)}" y2="${baselineY + 4}"></line>
      <text class="mini-time-label" x="${xFor(tick.index)}" y="${height - 8}">${escapeSvg(formatChartTime(tick.checkedAt))}</text>
    `).join("")}
  `;
}

function getNodeChartModel(points, item) {
  const currentFlow = Number(item.currentFlowMbps || 0);
  const bandwidth = Number(item.bandwidthMbps || 0);
  const values = normalizeChartValues(points, currentFlow, bandwidth);
  const width = 360;
  const height = 150;
  const pad = { top: 18, right: 12, bottom: 34, left: 34 };
  const maxY = Math.max(1, bandwidth, ...values.map((point) => point.flow)) * 1.08;
  const xFor = (index) => pad.left + (values.length === 1 ? 0 : index * ((width - pad.left - pad.right) / (values.length - 1)));
  const yFor = (value) => height - pad.bottom - (Number(value || 0) / maxY) * (height - pad.top - pad.bottom);
  return { values, width, height, pad, maxY, currentFlow, bandwidth, xFor, yFor };
}

function getNodeChartHoverPoints(points, item) {
  const { values, bandwidth, xFor, yFor } = getNodeChartModel(points, item);
  return values.map((point, index) => ({
    x: round(xFor(index), 2),
    y: round(yFor(point.flow), 2),
    flow: round(point.flow, 2),
    percent: percent(point.flow, bandwidth),
    checkedAt: point.checkedAt || ""
  }));
}

function getNodeMonitorTone(item) {
  const monitor = item.monitorSetting;
  const online = item.online !== 0;
  if (!monitor?.enabled || !isNowInMonitorWindow(monitor.startTime, monitor.endTime)) {
    return online ? "tone-blue" : "tone-red";
  }
  const expected = Number(monitor.expectedFlowMbps || 0);
  if (expected <= 0) return online ? "tone-blue" : "tone-red";
  const current = Number(item.currentFlowMbps || 0);
  if (current >= expected) return "tone-blue";
  if (current >= expected * 0.9) return "tone-yellow";
  return "tone-red";
}

function isNowInMonitorWindow(startTime, endTime) {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = hmToMinutes(startTime);
  const end = hmToMinutes(endTime);
  if (start === null || end === null) return false;
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function hmToMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function buildChartTicks(values, maxTicks) {
  if (!values.length) return [];
  const indexes = new Set([0, values.length - 1]);
  const slots = Math.max(1, Math.min(maxTicks, values.length) - 1);
  for (let index = 1; index < slots; index += 1) {
    indexes.add(Math.round((index * (values.length - 1)) / slots));
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => ({ index, checkedAt: values[index]?.checkedAt }));
}

function normalizeChartValues(points, currentFlow, bandwidth) {
  const values = (points.length ? points : [{ flow: currentFlow, bandwidth }])
    .map((point) => ({
      ...point,
      flow: Number(point.flow || 0),
      bandwidth
    }));
  if (!values.length) return [{ flow: currentFlow, bandwidth }];
  values[values.length - 1] = {
    ...values[values.length - 1],
    flow: currentFlow,
    bandwidth
  };
  return values;
}

function onNodeChartHover(event) {
  const svg = event.target.closest(".node-chart");
  if (!svg) {
    hideNodeChartTooltip();
    return;
  }
  const tooltip = svg.parentElement?.querySelector(".chart-tooltip");
  if (!tooltip) return;

  const uuid = svg.closest(".resource-tile")?.dataset.uuid;
  const points = nodeChartHoverPoints.get(uuid) || [];
  if (!points.length) return;

  const rect = svg.getBoundingClientRect();
  const viewX = ((event.clientX - rect.left) / rect.width) * 360;
  const nearest = points.reduce((best, point) => (
    Math.abs(point.x - viewX) < Math.abs(best.x - viewX) ? point : best
  ), points[0]);
  const left = Math.min(Math.max((nearest.x / 360) * rect.width, 14), rect.width - 14);
  const top = Math.min(Math.max((nearest.y / 150) * rect.height, 12), rect.height - 12);

  tooltip.innerHTML = `
    <strong>${escapeHtml(formatNumber(nearest.flow))} Mbps</strong>
    <span>${escapeHtml(formatPercent(nearest.percent))} · ${escapeHtml(formatChartTime(nearest.checkedAt))}</span>
  `;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.classList.add("show");
}

function hideNodeChartTooltip() {
  for (const tooltip of document.querySelectorAll(".chart-tooltip.show")) {
    tooltip.classList.remove("show");
  }
}

async function onResourceAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const uuid = button.dataset.uuid;
  if (!uuid) return;

  if (button.dataset.action === "copy-uuid") {
    await copyUuid(uuid, button);
    return;
  }

  if (button.dataset.action === "hide-node") {
    await updateNodeVisibility(uuid, true, button);
    return;
  }

  if (button.dataset.action === "dismiss-node-alert") {
    dismissNodeAlert(uuid);
    return;
  }

  if (button.dataset.action === "toggle-mute-menu") {
    event.stopPropagation();
    const wrap = button.closest(".mute-menu-wrap");
    const wasOpen = wrap?.classList.contains("open");
    closeMuteMenus();
    if (wrap && !wasOpen) wrap.classList.add("open");
    return;
  }

  if (button.dataset.action === "mute-alerts") {
    event.stopPropagation();
    await updateNodeAlertMute(uuid, button.dataset.duration, button);
    return;
  }

  if (button.dataset.action === "configure-alerts") {
    flippedTileUuid = flippedTileUuid === uuid ? "" : uuid;
    flippedTileMode = "alert";
    tileAlertDrafts.set(uuid, cloneAlerts(latestPayload?.nodeSettings?.nodeAlerts?.[uuid] || []));
    render(latestPayload);
    return;
  }

  if (button.dataset.action === "configure-monitor") {
    flippedTileUuid = flippedTileUuid === uuid && flippedTileMode === "monitor" ? "" : uuid;
    flippedTileMode = "monitor";
    const resource = latestPayload?.state?.latest?.resources?.find((item) => item.uuid === uuid);
    tileMonitorDrafts.set(uuid, { ...getTileMonitorDraft(uuid, resource?.monitorSetting) });
    render(latestPayload);
    return;
  }

  if (button.dataset.action === "close-tile-alerts") {
    flippedTileUuid = "";
    render(latestPayload);
    return;
  }

  if (button.dataset.action === "add-tile-alert-rule") {
    addTileAlertRule(uuid);
    return;
  }

  if (button.dataset.action === "remove-tile-alert-rule") {
    removeTileAlertRule(uuid, Number(button.dataset.index));
    return;
  }

  if (button.dataset.action === "save-tile-alerts") {
    await saveTileAlerts(uuid, button);
    return;
  }

  if (button.dataset.action === "save-tile-monitor") {
    await saveTileMonitor(uuid, button);
    return;
  }

  if (button.dataset.action === "clear-tile-monitor") {
    await clearTileMonitor(uuid, button);
    return;
  }
}

function onTileAlertInput(event) {
  const input = event.target.closest("[data-tile-alert-field]");
  if (!input) return;
  const uuid = input.dataset.uuid;
  const rule = getTileAlertDraft(uuid)[Number(input.dataset.index)];
  if (!rule) return;
  if (input.dataset.tileAlertField === "enabled") rule.enabled = input.checked;
  if (input.dataset.tileAlertField === "time") rule.time = input.value || "00:00";
  if (input.dataset.tileAlertField === "thresholdPercent") rule.thresholdPercent = Number(input.value || 0);
}

function onTileMonitorInput(event) {
  const input = event.target.closest("[data-monitor-field]");
  if (!input) return;
  const monitor = getTileMonitorDraft(input.dataset.uuid);
  if (input.dataset.monitorField === "enabled") monitor.enabled = input.checked;
  if (input.dataset.monitorField === "startTime") monitor.startTime = input.value || "00:00";
  if (input.dataset.monitorField === "endTime") monitor.endTime = input.value || "23:59";
  if (input.dataset.monitorField === "expectedFlowMbps") monitor.expectedFlowMbps = Number(input.value || 0);
}

async function onHiddenMenuAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "copy-uuid") {
    await copyUuid(button.dataset.uuid, button);
    return;
  }
  if (button.dataset.action === "unhide-node") {
    await updateNodeVisibility(button.dataset.uuid, false, button);
  }
}

function onResourceDragStart(event) {
  const tile = event.target.closest(".resource-tile");
  if (!tile) return;
  draggedUuid = tile.dataset.uuid || "";
  tile.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedUuid);
}

function onResourceDragOver(event) {
  const tile = event.target.closest(".resource-tile");
  if (!tile || !draggedUuid || tile.dataset.uuid === draggedUuid) return;
  event.preventDefault();
  tile.classList.add("drag-over");
}

function onResourceDragLeave(event) {
  const tile = event.target.closest(".resource-tile");
  if (tile) tile.classList.remove("drag-over");
}

async function onResourceDrop(event) {
  const targetTile = event.target.closest(".resource-tile");
  if (!targetTile || !draggedUuid || targetTile.dataset.uuid === draggedUuid) return;
  event.preventDefault();

  const tiles = [...els.resources.querySelectorAll(".resource-tile")];
  const uuids = tiles.map((tile) => tile.dataset.uuid);
  const from = uuids.indexOf(draggedUuid);
  const to = uuids.indexOf(targetTile.dataset.uuid);
  if (from === -1 || to === -1) return;

  uuids.splice(from, 1);
  uuids.splice(to, 0, draggedUuid);
  await saveNodeOrder(uuids);
}

function onResourceDragEnd() {
  draggedUuid = "";
  for (const tile of els.resources.querySelectorAll(".resource-tile")) {
    tile.classList.remove("dragging", "drag-over");
  }
}

async function saveNodeOrder(uuids) {
  els.saveMessage.textContent = "正在保存节点排序...";
  try {
    const hidden = latestPayload?.nodeSettings?.hiddenNodeUuids || [];
    const fullOrder = [...uuids, ...hidden.filter((uuid) => !uuids.includes(uuid))];
    const res = await fetch("/api/node-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuids: fullOrder })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "排序保存失败");
    latestPayload.nodeSettings = body.nodeSettings;
    render(latestPayload);
    els.saveMessage.textContent = "节点排序已保存";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  }
}

async function copyUuid(uuid, button) {
  try {
    await navigator.clipboard.writeText(uuid);
    flashButton(button, "已复制");
  } catch {
    fallbackCopy(uuid);
    flashButton(button, "已复制");
  }
}

function fallbackCopy(text) {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function flashButton(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1000);
}

function addTileAlertRule(uuid) {
  const draft = getTileAlertDraft(uuid);
  draft.push({
    id: `${uuid}-time-percent-below-${Date.now()}`,
    type: "time_percent_below",
    enabled: true,
    time: "00:00",
    thresholdPercent: 10
  });
  render(latestPayload);
}

function removeTileAlertRule(uuid, index) {
  const draft = getTileAlertDraft(uuid);
  draft.splice(index, 1);
  render(latestPayload);
}

async function saveTileAlerts(uuid, button) {
  button.disabled = true;
  els.saveMessage.textContent = "正在保存节点报警设置...";
  try {
    const alerts = getTileAlertDraft(uuid);
    const res = await fetch("/api/node-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, alerts })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "保存失败");
    latestPayload.nodeSettings = body.nodeSettings;
    tileAlertDrafts.set(uuid, cloneAlerts(body.nodeSettings?.nodeAlerts?.[uuid] || []));
    flippedTileUuid = "";
    render(latestPayload);
    els.saveMessage.textContent = "节点报警设置已保存";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function saveTileMonitor(uuid, button) {
  button.disabled = true;
  els.saveMessage.textContent = "正在保存监控预期...";
  try {
    const monitor = getTileMonitorDraft(uuid);
    const res = await fetch("/api/node-monitor-setting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, monitor })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "保存失败");
    latestPayload.nodeSettings = body.nodeSettings;
    tileMonitorDrafts.set(uuid, { ...(body.nodeSettings?.nodeMonitors?.[uuid] || monitor) });
    flippedTileUuid = "";
    render(latestPayload);
    els.saveMessage.textContent = "监控预期已保存";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function clearTileMonitor(uuid, button) {
  button.disabled = true;
  els.saveMessage.textContent = "正在清除监控预期...";
  try {
    const res = await fetch("/api/node-monitor-setting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, monitor: null })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "清除失败");
    latestPayload.nodeSettings = body.nodeSettings;
    tileMonitorDrafts.delete(uuid);
    flippedTileUuid = "";
    render(latestPayload);
    els.saveMessage.textContent = "监控预期已清除";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function addNodeAlertRule() {
  if (!selectedNodeUuid) {
    els.nodeAlertMessage.textContent = "请先选择一个节点";
    return;
  }
  draftNodeAlerts.push({
    id: `${selectedNodeUuid}-time-percent-below-${Date.now()}`,
    type: "time_percent_below",
    enabled: true,
    time: "00:00",
    thresholdPercent: 10
  });
  renderNodeAlertPanel(latestPayload?.state?.latest?.resources || [], latestPayload?.nodeSettings || {});
}

function onNodeAlertListClick(event) {
  const button = event.target.closest("button[data-action='remove-alert-rule']");
  if (!button) return;
  draftNodeAlerts.splice(Number(button.dataset.index), 1);
  renderNodeAlertPanel(latestPayload?.state?.latest?.resources || [], latestPayload?.nodeSettings || {});
}

function onNodeAlertListInput(event) {
  const input = event.target.closest("[data-field]");
  if (!input) return;
  const rule = draftNodeAlerts[Number(input.dataset.index)];
  if (!rule) return;
  if (input.dataset.field === "enabled") rule.enabled = input.checked;
  if (input.dataset.field === "time") rule.time = input.value || "00:00";
  if (input.dataset.field === "thresholdPercent") rule.thresholdPercent = Number(input.value || 0);
}

async function saveNodeAlerts() {
  if (!selectedNodeUuid) {
    els.nodeAlertMessage.textContent = "请先选择一个节点";
    return;
  }
  els.saveNodeAlerts.disabled = true;
  els.nodeAlertMessage.textContent = "正在保存报警...";
  try {
    const res = await fetch("/api/node-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid: selectedNodeUuid, alerts: draftNodeAlerts })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "保存失败");
    latestPayload.nodeSettings = body.nodeSettings;
    draftNodeAlerts = cloneAlerts(body.nodeSettings?.nodeAlerts?.[selectedNodeUuid] || []);
    render(latestPayload);
    els.nodeAlertMessage.textContent = "报警设置已保存";
  } catch (error) {
    els.nodeAlertMessage.textContent = error.message;
  } finally {
    els.saveNodeAlerts.disabled = false;
  }
}

async function saveServerChanSettings() {
  els.saveServerChanSettings.disabled = true;
  els.serverChanMessage.textContent = "正在保存 Server酱设置...";
  try {
    const payload = {
      enabled: els.serverChanEnabled.checked,
      sendKey: els.serverChanSendKey.value.trim(),
      subjectPrefix: els.subjectPrefix.value.trim(),
      cooldownSeconds: Number(els.cooldownSeconds.value || 0)
    };
    if (!payload.sendKey) delete payload.sendKey;
    const res = await fetch("/api/serverchan-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "保存失败");
    latestPayload.config = body.config;
    latestPayload.serverChanSettings = body.serverChanSettings;
    serverChanFormDirty = false;
    render(latestPayload);
    els.serverChanMessage.textContent = "Server酱设置已保存";
  } catch (error) {
    els.serverChanMessage.textContent = error.message;
  } finally {
    els.saveServerChanSettings.disabled = false;
  }
}

async function updateNodeVisibility(uuid, hidden, button) {
  button.disabled = true;
  els.saveMessage.textContent = hidden ? "正在隐藏节点..." : "正在恢复节点...";
  try {
    const res = await fetch("/api/node-visibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, hidden })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "操作失败");
    latestPayload.nodeSettings = body.nodeSettings;
    render(latestPayload);
    els.saveMessage.textContent = hidden ? "节点已隐藏" : "节点已恢复";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function updateNodeAlertMute(uuid, duration, button) {
  button.disabled = true;
  els.saveMessage.textContent = "正在保存报警禁用设置...";
  try {
    const res = await fetch("/api/node-alert-mute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, duration })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "报警禁用设置保存失败");
    latestPayload.nodeSettings = body.nodeSettings;
    render(latestPayload);
    els.saveMessage.textContent = duration === "none" ? "报警已恢复" : "报警已禁用";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function dismissNodeAlert(uuid) {
  const activeAlerts = latestPayload?.state?.activeAlerts || [];
  for (const alert of activeAlerts) {
    if (alert.nodeUuid === uuid && alert.id) dismissedNodeAlertIds.add(alert.id);
  }
  writeDismissedNodeAlertIds();
  render(latestPayload);
  els.saveMessage.textContent = "当前节点报警提示已消除";
}

async function saveSamplingInterval() {
  if (!latestPayload?.config) return;
  const intervalSeconds = Math.max(10, Number(els.intervalSeconds.value || 60));
  els.intervalSeconds.disabled = true;
  els.saveMessage.textContent = "正在保存采集频率...";
  try {
    const nextConfig = {
      ...latestPayload.config,
      schedule: {
        ...(latestPayload.config.schedule || {}),
        intervalSeconds
      }
    };
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextConfig)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "采集频率保存失败");
    latestPayload.config = body;
    renderSamplingInterval(body);
    els.saveMessage.textContent = `采集频率已设置为 ${formatInterval(intervalSeconds)}`;
  } catch (error) {
    els.saveMessage.textContent = error.message;
    renderSamplingInterval(latestPayload.config);
  } finally {
    els.intervalSeconds.disabled = false;
  }
}

async function runAction(url, button, successText, messageEl = els.saveMessage) {
  button.disabled = true;
  messageEl.textContent = "正在执行...";
  try {
    const res = await fetch(url, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "请求失败");
    messageEl.textContent = successText;
  } catch (error) {
    messageEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loginAccount(event) {
  event.preventDefault();
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;
  if (!username || !password) {
    els.loginMessage.textContent = "请输入账号和密码";
    return;
  }

  els.loginButton.disabled = true;
  els.loginMessage.textContent = "正在登录并刷新资源数据...";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "登录失败");
    els.loginPassword.value = "";
    els.loginMessage.textContent = `${body.message}，HTTP ${body.metrics?.httpStatus ?? "-"}`;
  } catch (error) {
    els.loginMessage.textContent = error.message;
  } finally {
    els.loginButton.disabled = false;
  }
}

function cloneAlerts(alerts) {
  return (alerts || []).map((item) => ({ ...item }));
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatValue(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function percent(value, total) {
  const number = Number(value || 0);
  const denominator = Number(total || 0);
  if (!Number.isFinite(number) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return round((number / denominator) * 100, 2);
}

function formatPercent(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "-";
  return `${number.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}

function formatInterval(seconds) {
  const value = Number(seconds || 0);
  if (value >= 60 && value % 60 === 0) return `${value / 60} 分钟`;
  return `${value} 秒`;
}

function formatChartTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(-5) || "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeSvg(value) {
  return escapeHtml(value);
}
