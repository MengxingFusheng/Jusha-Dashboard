const els = {
  targetLabel: document.querySelector("#targetLabel"),
  runStatus: document.querySelector("#runStatus"),
  lastRun: document.querySelector("#lastRun"),
  alertCount: document.querySelector("#alertCount"),
  serverChanBadge: document.querySelector("#serverChanBadge"),
  alertLogs: document.querySelector("#alertLogs"),
  clearAlertLogs: document.querySelector("#clearAlertLogs"),
  resources: document.querySelector("#resources"),
  resourceCount: document.querySelector("#resourceCount"),
  resourceTileScale: document.querySelector("#resourceTileScale"),
  resourceTileScaleValue: document.querySelector("#resourceTileScaleValue"),
  hiddenMenu: document.querySelector("#hiddenMenu"),
  incomeBadge: document.querySelector("#incomeBadge"),
  incomeSummary: document.querySelector("#incomeSummary"),
  incomeTiles: document.querySelector("#incomeTiles"),
  incomeTileScale: document.querySelector("#incomeTileScale"),
  incomeTileScaleValue: document.querySelector("#incomeTileScaleValue"),
  incomeCheckNow: document.querySelector("#incomeCheckNow"),
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
const dismissedAlertLogKeys = new Set(readDismissedAlertLogKeys());
const TILE_SCALE_LIMITS = { min: 0.85, max: 1.3 };

els.checkNow.addEventListener("click", () => runAction("/api/check", els.checkNow, "????"));
els.incomeCheckNow.addEventListener("click", () => runAction("/api/income/check", els.incomeCheckNow, "???????"));
els.intervalSeconds.addEventListener("change", saveSamplingInterval);
els.resourceTileScale?.addEventListener("input", () => setTileScale("resource", els.resourceTileScale.value));
els.incomeTileScale?.addEventListener("input", () => setTileScale("income", els.incomeTileScale.value));
els.testServerChan.addEventListener("click", () => runAction("/api/test-serverchan", els.testServerChan, "???????", els.serverChanMessage));
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
els.alertLogs.addEventListener("click", onAlertLogAction);
els.clearAlertLogs.addEventListener("click", clearAlertLogs);
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

initTileScaleControls();

const events = new EventSource("/events");
events.onmessage = (event) => render(JSON.parse(event.data));
events.onerror = () => {
  els.runStatus.textContent = "????";
  els.runStatus.className = "badge danger";
};

fetch("/api/state")
  .then((res) => res.json())
  .then(render)
  .catch((error) => {
    els.runStatus.textContent = "????";
    els.runStatus.className = "badge danger";
    els.saveMessage.textContent = error.message;
  });

function render(payload) {
  latestPayload = payload;
  const { state, config, history, auth, nodeSettings, serverChanSettings, income } = payload;
  const latest = state.latest;
  const metrics = latest?.metrics || {};
  const resources = latest?.resources || [];

  ensureSelectedNode(resources, nodeSettings);

  els.targetLabel.textContent = `${config.target.name} ? ${config.target.url}`;
  els.runStatus.textContent = latest?.ok ? "??" : latest ? "??" : "????";
  els.runStatus.className = `badge ${latest?.ok ? "ok" : latest ? "danger" : "muted"}`;
  els.lastRun.textContent = latest ? `???? ${formatTime(latest.checkedAt)}` : "???? -";
  els.cookieBadge.textContent = auth?.hasCookie ? `Cookie ??? (${auth.cookieLength} ??)` : "??? Cookie";
  els.cookieBadge.className = `badge ${auth?.hasCookie ? "ok" : "muted"}`;
  els.serverChanBadge.textContent = config.serverChan?.enabled ? "?????" : "?????";
  els.serverChanBadge.className = `badge ${config.serverChan?.enabled ? "ok" : "muted"}`;
  renderSamplingInterval(config);

  syncDismissedNodeAlerts(state.activeAlerts || []);
  renderResources(resources, metrics, history || [], nodeSettings || {}, state.activeAlerts || [], income || {});
  renderIncomePanel(income || {}, resources, nodeSettings || {});
  renderHiddenMenu(resources, nodeSettings);
  renderNodeAlertPanel(resources, nodeSettings);
  renderAlertLogs(state.activeAlerts || [], history || []);
  renderServerChanSettings(serverChanSettings || {});
}

function initTileScaleControls() {
  setTileScale("resource", readTileScale("resource"), false);
  setTileScale("income", readTileScale("income"), false);
}

function readTileScale(kind) {
  const raw = localStorage.getItem(`${kind}TileScale`);
  return clampTileScale(raw || 1);
}

function setTileScale(kind, value, persist = true) {
  const scale = clampTileScale(value);
  const minBase = kind === "resource" ? 320 : 280;
  const root = document.documentElement;
  root.style.setProperty(`--${kind}-tile-scale`, String(scale));
  root.style.setProperty(`--${kind}-tile-min`, `${Math.round(minBase * scale)}px`);

  const input = kind === "resource" ? els.resourceTileScale : els.incomeTileScale;
  const output = kind === "resource" ? els.resourceTileScaleValue : els.incomeTileScaleValue;
  if (input) input.value = String(scale);
  if (output) output.textContent = `${Math.round(scale * 100)}%`;
  if (persist) localStorage.setItem(`${kind}TileScale`, String(scale));
}

function clampTileScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  const rounded = Math.round(number * 20) / 20;
  return Math.min(TILE_SCALE_LIMITS.max, Math.max(TILE_SCALE_LIMITS.min, rounded));
}

function ensureSelectedNode(resources, nodeSettings = {}) {
  if (selectedNodeUuid && resources.some((item) => item.uuid === selectedNodeUuid)) return;
  const firstVisible = resources.find((item) => !isResourceHidden(item, nodeSettings));
  const firstAny = resources[0];
  selectedNodeUuid = firstVisible?.uuid || firstAny?.uuid || "";
  draftNodeAlerts = cloneAlerts(nodeSettings?.nodeAlerts?.[selectedNodeUuid] || []);
}

function renderResources(resources, metrics = {}, history = [], nodeSettings = {}, activeAlerts = [], income = {}) {
  const visibleResources = sortResources(resources.filter((item) => !isResourceHidden(item, nodeSettings)), nodeSettings);
  const manualHidden = new Set(nodeSettings.hiddenNodeUuids || []).size || Number(metrics.resourceManuallyHidden || 0);
  els.resourceCount.textContent = `?? ${visibleResources.length} ? ? ???? ${manualHidden} ? ? ???? ${Number(metrics.resourceHidden || 0)} ?`;

  const series = buildNodeSeries(history);
  const activeAlertsByNode = groupActiveAlertsByNode(activeAlerts);
  const incomeByNode = buildIncomeMap(income);
  nodeChartHoverPoints.clear();
  els.resources.innerHTML = visibleResources.length ? visibleResources.map((item) => {
    const points = series.get(item.uuid) || [];
    const alertCount = (item.nodeAlerts || []).length;
    const activeNodeAlerts = activeAlertsByNode.get(item.uuid) || [];
    const incomeItem = incomeByNode.get(item.uuid);
    const mute = getActiveNodeMute(item.uuid, nodeSettings);
    const muteActive = Boolean(mute);
    nodeChartHoverPoints.set(item.uuid, getNodeChartHoverPoints(points, item));
    return `
      <article class="resource-tile ${flippedTileUuid === item.uuid ? "is-flipped" : ""}" draggable="${flippedTileUuid === item.uuid ? "false" : "true"}" data-uuid="${escapeHtml(item.uuid)}">
        <button type="button" class="tile-hide-button" data-action="hide-node" data-uuid="${escapeHtml(item.uuid)}" title="????" aria-label="????">?</button>
        <div class="resource-tile-head">
          <div>
            <div class="node-title-row">
              <span class="drag-handle" title="????">?</span>
              <strong>${escapeHtml(item.remark || "?????")}</strong>
              ${renderUnitPriceTag(incomeItem)}
            </div>
            <button type="button" class="uuid-button" data-action="copy-uuid" data-uuid="${escapeHtml(item.uuid)}" title="???? UUID">UUID</button>
          </div>
          <div class="tile-head-side">
            <span class="status-pill ${item.online === 0 ? "offline" : "online"}">${escapeHtml(item.statusLabel || item.status)}</span>
            <div class="tile-actions">
              ${activeNodeAlerts.length ? `
                <button type="button" class="tile-alert-button" data-action="dismiss-node-alert" data-uuid="${escapeHtml(item.uuid)}" title="??????????" aria-label="??????????">
                  &#128276;
                  <span>${activeNodeAlerts.length}</span>
                </button>
              ` : ""}
              <div class="mute-menu-wrap">
                <button type="button" class="icon-button mute-button ${muteActive ? "active" : ""}" data-action="toggle-mute-menu" data-uuid="${escapeHtml(item.uuid)}" title="${escapeHtml(formatMuteTitle(mute))}" aria-label="${escapeHtml(formatMuteTitle(mute))}">
                  &#128277;
                </button>
                <div class="mute-menu" role="menu">
                  <button type="button" class="mute-option" data-action="mute-alerts" data-duration="1h" data-uuid="${escapeHtml(item.uuid)}">?? 1 ??</button>
                  <button type="button" class="mute-option" data-action="mute-alerts" data-duration="24h" data-uuid="${escapeHtml(item.uuid)}">?? 24 ??</button>
                  <button type="button" class="mute-option" data-action="mute-alerts" data-duration="forever" data-uuid="${escapeHtml(item.uuid)}">????</button>
                  ${muteActive ? `<button type="button" class="mute-option restore" data-action="mute-alerts" data-duration="none" data-uuid="${escapeHtml(item.uuid)}">????</button>` : ""}
                </div>
              </div>
              <button type="button" class="icon-button monitor-button" data-action="configure-monitor" data-uuid="${escapeHtml(item.uuid)}" title="????" aria-label="????">
                ?
              </button>
              <button type="button" class="icon-button gear-button" data-action="configure-alerts" data-uuid="${escapeHtml(item.uuid)}" title="????" aria-label="????">
                ?
                ${alertCount ? `<span class="alert-count-badge">${alertCount}</span>` : ""}
              </button>
            </div>
          </div>
        </div>
        <div class="resource-stats">
          <div><strong>${escapeHtml(formatNumber(item.currentFlowMbps))}<span>Mbps</span></strong></div>
          <div><strong>${escapeHtml(formatNumber(item.bandwidthUsagePercent))}<span>%</span></strong></div>
        </div>
        ${renderTileIncome(incomeItem, income, item.incomeForecast)}
        <div class="node-chart-wrap">
          <svg class="node-chart" viewBox="0 0 360 150" role="img" aria-label="${escapeHtml(item.remark || item.uuid || "??")}????">
            ${renderNodeChart(points, item)}
          </svg>
          <div class="chart-tooltip" aria-hidden="true"></div>
        </div>
        <div class="tile-alert-back">
          ${flippedTileMode === "monitor" ? renderTileMonitorSettings(item) : renderTileAlertSettings(item)}
        </div>
      </article>
    `;
  }).join("") : `<div class="empty-tile">?????????</div>`;
}

function renderTileIncome(item, income = {}, forecast = null) {
  const forecastReady = forecast?.status === "ready";
  return `
    <div class="tile-income-strip">
      <div>
        <span>????</span>
        <strong>${item ? `?${escapeHtml(formatCurrency(item.incomeYuan))}` : "-"}</strong>
      </div>
      <div>
        <span>????</span>
        <strong>${item ? escapeHtml(formatFlowGb(item.flowGb)) : "-"}</strong>
      </div>
      <div>
        <span>????</span>
        <strong>${forecastReady ? `?${escapeHtml(formatCurrency(forecast.estimatedIncomeYuan))}` : "-"}</strong>
      </div>
      <div>
        <span>??95</span>
        <strong>${forecastReady ? escapeHtml(formatFlowGb(forecast.estimatedSettlementFlowGb)) : "-"}</strong>
      </div>
    </div>
  `;
}

function renderUnitPriceTag(item) {
  const monthlyPrice = calculateMonthlyUnitPrice(item);
  if (!monthlyPrice) return "";
  return `<span class="node-unit-price">?${escapeHtml(formatCurrency(monthlyPrice))}/?</span>`;
}

function renderIncomePanel(income = {}, resources = [], nodeSettings = {}) {
  const items = Array.isArray(income.items) ? income.items : [];
  const summary = income.summary || {};
  const month = income.month || null;
  const monthTaxRate = Number(month?.taxRate ?? 0.06);
  els.incomeBadge.textContent = getIncomeStatusText(income);
  els.incomeBadge.className = `badge ${getIncomeStatusClass(income)}`;
  els.incomeSummary.innerHTML = `
    <div class="income-summary-card">
      <span>??</span>
      <strong>${escapeHtml(income.date || income.targetDate || "-")}</strong>
    </div>
    <div class="income-summary-card">
      <span>?????</span>
      <strong>?${escapeHtml(formatCurrency(summary.totalIncomeYuan))}</strong>
    </div>
    <div class="income-summary-card">
      <span>?????</span>
      <strong>${escapeHtml(formatFlowGb(summary.totalFlowGb))}</strong>
    </div>
    <div class="income-summary-card">
      <span>??????</span>
      <strong>${month ? `?${escapeHtml(formatCurrency(month.totalIncomeYuan))}` : "-"}</strong>
    </div>
    <div class="income-summary-card">
      <span>??????(${escapeHtml(formatTaxRate(monthTaxRate))})</span>
      <strong>${month ? `?${escapeHtml(formatCurrency(month.netIncomeYuan))}` : "-"}</strong>
    </div>
    <div class="income-summary-card">
      <span>????</span>
      <strong>${Number(summary.count || items.length)} ?</strong>
    </div>
  `;

  const resourceByUuid = new Map(resources.map((item) => [item.uuid, item]));
  const displayItems = items
    .map((item) => ({ income: item, resource: resourceByUuid.get(item.uuid) }))
    .sort((left, right) => {
      const leftHidden = left.resource ? isResourceHidden(left.resource, nodeSettings) : false;
      const rightHidden = right.resource ? isResourceHidden(right.resource, nodeSettings) : false;
      if (leftHidden !== rightHidden) return leftHidden ? 1 : -1;
      return String(left.income.remark || left.resource?.remark || left.income.uuid)
        .localeCompare(String(right.income.remark || right.resource?.remark || right.income.uuid), "zh-CN");
    });

  if (!displayItems.length) {
    const detail = income.error
      ? `???????${income.error}`
      : income.lastCheckedAt
        ? `???? ${formatTime(income.lastCheckedAt)}???????????`
        : "?????????";
    els.incomeTiles.innerHTML = `<div class="empty-tile">${escapeHtml(detail)}</div>`;
    return;
  }

  els.incomeTiles.innerHTML = displayItems.map(({ income: item, resource }) => {
    const name = item.remark || resource?.remark || item.host || "?????";
    const usage = formatSettlementUsage(item, resource);
    const status = resource ? (resource.statusLabel || resource.status || "-") : "?????";
    return `
      <article class="income-tile">
        <div class="income-tile-head">
          <div>
            <div class="income-name-row">
              <strong>${escapeHtml(name)}</strong>
              ${renderUnitPriceTag(item)}
            </div>
            <span>${escapeHtml(item.host || resource?.host || item.uuid)}</span>
          </div>
          <span class="status-pill ${resource?.online === 0 ? "offline" : "online"}">${escapeHtml(status)}</span>
        </div>
        <div class="income-metrics">
          <div><span>??</span><strong>?${escapeHtml(formatCurrency(item.incomeYuan))}</strong></div>
          <div><span>???</span><strong>${escapeHtml(usage)}</strong></div>
          <div><span>????</span><strong>${escapeHtml(formatFlowGb(item.flowGb))}</strong></div>
        </div>
        <div class="income-uuid">${escapeHtml(item.uuid)}</div>
      </article>
    `;
  }).join("");
}

function buildIncomeMap(income = {}) {
  return new Map((income.items || []).map((item) => [item.uuid, item]));
}

function getIncomeStatusText(income = {}) {
  if (income.status === "ready" || income.ready) return `${income.date || "??"} ???`;
  if (income.status === "checking") return "??????";
  if (income.status === "error") return "??????";
  if (income.status === "waiting") return "??????";
  return "??????";
}

function getIncomeStatusClass(income = {}) {
  if (income.status === "ready" || income.ready) return "ok";
  if (income.status === "error") return "danger";
  if (income.status === "checking" || income.status === "waiting") return "warn";
  return "muted";
}

function isResourceHidden(resource, nodeSettings = {}) {
  return Boolean(resource?.uiHidden || (resource?.uuid && (nodeSettings.hiddenNodeUuids || []).includes(resource.uuid)));
}

function renderHiddenMenu(resources, nodeSettings = {}) {
  const hiddenUuids = new Set(nodeSettings.hiddenNodeUuids || []);
  const hiddenResources = sortResources(resources.filter((item) => hiddenUuids.has(item.uuid)), nodeSettings);
  if (!hiddenResources.length) {
    els.hiddenMenu.innerHTML = `<span class="badge muted">??? 0 ?</span>`;
    return;
  }

  els.hiddenMenu.innerHTML = `
    <details class="hidden-dropdown">
      <summary class="hidden-summary">??? ${hiddenResources.length} ?</summary>
      <div class="hidden-dropdown-body">
        ${hiddenResources.map((item) => `
          <div class="hidden-node-row">
            <div>
              <strong>${escapeHtml(item.remark || "?????")}</strong>
              <button type="button" class="uuid-button small" data-action="copy-uuid" data-uuid="${escapeHtml(item.uuid)}" title="???? UUID">UUID</button>
            </div>
            <button type="button" class="ghost-button" data-action="unhide-node" data-uuid="${escapeHtml(item.uuid)}">????</button>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function renderNodeAlertPanel(resources, nodeSettings = {}) {
  const resource = resources.find((item) => item.uuid === selectedNodeUuid);
  if (!resource) {
    els.selectedNodeLabel.textContent = "???????";
    els.nodeAlertList.innerHTML = `<div class="empty">?????????</div>`;
    return;
  }

  const storedAlerts = nodeSettings.nodeAlerts?.[resource.uuid] || [];
  if (!draftNodeAlerts.length && storedAlerts.length) draftNodeAlerts = cloneAlerts(storedAlerts);

  els.selectedNodeLabel.textContent = `${resource.remark || "?????"} ? UUID ???`;
  els.nodeAlertList.innerHTML = draftNodeAlerts.length ? draftNodeAlerts.map((rule, index) => `
    <article class="alert-rule-card" data-index="${index}">
      <div class="alert-rule-head">
        <div>
          <strong>???? 1</strong>
          <span>????????????</span>
        </div>
        <button type="button" class="ghost-button danger" data-action="remove-alert-rule" data-index="${index}">??</button>
      </div>
      <div class="alert-rule-grid">
        <label class="switch-row">
          <span>??</span>
          <input type="checkbox" data-field="enabled" data-index="${index}" ${rule.enabled ? "checked" : ""}>
        </label>
        <label>
          <span>???</span>
          <input type="time" data-field="time" data-index="${index}" value="${escapeHtml(rule.time || "00:00")}">
        </label>
        <label>
          <span>???????</span>
          <input type="number" min="0" max="999" step="0.01" data-field="thresholdPercent" data-index="${index}" value="${escapeHtml(String(rule.thresholdPercent ?? 0))}">
        </label>
      </div>
    </article>
  `).join("") : `<div class="empty">????????????????????????</div>`;
}

function renderTileAlertSettings(resource) {
  const rules = getTileAlertDraft(resource.uuid, resource.nodeAlerts || []);
  return `
    <div class="tile-alert-settings">
      <div class="tile-alert-settings-head">
        <div>
          <strong>${escapeHtml(resource.remark || "?????")}</strong>
          <span>????</span>
        </div>
        <button type="button" class="icon-button" data-action="close-tile-alerts" data-uuid="${escapeHtml(resource.uuid)}" title="????" aria-label="????">?</button>
      </div>
      <div class="tile-alert-rules">
        ${rules.length ? rules.map((rule, index) => renderTileAlertRule(rule, index, resource.uuid)).join("") : `<div class="empty compact-empty">???????????</div>`}
      </div>
      <div class="tile-alert-footer">
        <button type="button" class="ghost-button" data-action="add-tile-alert-rule" data-uuid="${escapeHtml(resource.uuid)}">????</button>
        <button type="button" data-action="save-tile-alerts" data-uuid="${escapeHtml(resource.uuid)}">??</button>
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
          <strong>${escapeHtml(resource.remark || "?????")}</strong>
          <span>????</span>
        </div>
        <button type="button" class="icon-button" data-action="close-tile-alerts" data-uuid="${escapeHtml(resource.uuid)}" title="????" aria-label="????">?</button>
      </div>
      <div class="tile-monitor-form">
        <label class="switch-row">
          <span>??</span>
          <input type="checkbox" data-monitor-field="enabled" data-uuid="${escapeHtml(resource.uuid)}" ${monitor.enabled ? "checked" : ""}>
        </label>
        <label>
          <span>????</span>
          <input type="time" data-monitor-field="startTime" data-uuid="${escapeHtml(resource.uuid)}" value="${escapeHtml(monitor.startTime)}">
        </label>
        <label>
          <span>????</span>
          <input type="time" data-monitor-field="endTime" data-uuid="${escapeHtml(resource.uuid)}" value="${escapeHtml(monitor.endTime)}">
        </label>
        <label>
          <span>???? Mbps</span>
          <input type="number" min="0" step="0.01" data-monitor-field="expectedFlowMbps" data-uuid="${escapeHtml(resource.uuid)}" value="${escapeHtml(String(monitor.expectedFlowMbps ?? 0))}">
        </label>
        <div class="monitor-color-guide">
          <span><i class="guide-blue"></i>??</span>
          <span><i class="guide-yellow"></i>?? 10% ?</span>
          <span><i class="guide-red"></i>?? 10% ??</span>
        </div>
      </div>
      <div class="tile-alert-footer">
        <button type="button" class="ghost-button danger" data-action="clear-tile-monitor" data-uuid="${escapeHtml(resource.uuid)}">??</button>
        <button type="button" data-action="save-tile-monitor" data-uuid="${escapeHtml(resource.uuid)}">??</button>
      </div>
    </div>
  `;
}

function renderTileAlertRule(rule, index, uuid) {
  return `
    <article class="tile-alert-rule" data-uuid="${escapeHtml(uuid)}" data-index="${index}">
      <div class="tile-alert-rule-head">
        <strong>?? 1</strong>
        <button type="button" class="ghost-button danger" data-action="remove-tile-alert-rule" data-uuid="${escapeHtml(uuid)}" data-index="${index}">??</button>
      </div>
      <label class="switch-row">
        <span>??</span>
        <input type="checkbox" data-tile-alert-field="enabled" data-uuid="${escapeHtml(uuid)}" data-index="${index}" ${rule.enabled ? "checked" : ""}>
      </label>
      <label>
        <span>???</span>
        <input type="time" data-tile-alert-field="time" data-uuid="${escapeHtml(uuid)}" data-index="${index}" value="${escapeHtml(rule.time || "00:00")}">
      </label>
      <label>
        <span>??????</span>
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
  const logs = getVisibleAlertLogs(activeAlerts, history);

  els.alertCount.textContent = `${logs.length} ?`;
  els.clearAlertLogs.disabled = logs.length === 0;
  els.alertLogs.innerHTML = logs.length ? logs.map((alert) => `
    <div class="alert ${alert.severity === "critical" ? "critical" : ""}" data-alert-key="${escapeHtml(alert.logKey)}">
      <button type="button" class="alert-close-button" data-action="dismiss-alert-log" data-alert-key="${escapeHtml(alert.logKey)}" title="??????" aria-label="??????">?</button>
      <strong>${escapeHtml(alert.message || alert.id)}</strong>
      <span>${escapeHtml(alert.nodeRemark || alert.metric || "-")} ? ${escapeHtml(formatValue(alert.actual))} ? ${escapeHtml(formatTime(alert.triggeredAt || alert.snapshotAt))}</span>
    </div>
  `).join("") : `<div class="empty">??????</div>`;
}

function getVisibleAlertLogs(activeAlerts = [], history = []) {
  return buildAlertLogs(activeAlerts, history)
    .filter((alert) => !dismissedAlertLogKeys.has(alert.logKey))
    .slice(0, 60);
}

function buildAlertLogs(activeAlerts = [], history = []) {
  return [
    ...activeAlerts.map((item) => withAlertLogKey({ ...item, live: true })),
    ...history.flatMap((snapshot) => (snapshot.alerts || []).map((alert) => withAlertLogKey({
      ...alert,
      snapshotAt: snapshot.checkedAt,
      live: false
    })))
  ];
}

function withAlertLogKey(alert) {
  const time = alert.triggeredAt || alert.snapshotAt || "";
  const identity = alert.id || alert.message || alert.metric || "";
  const scope = alert.live ? "live" : "history";
  return {
    ...alert,
    logKey: `${scope}:${identity}:${time}`
  };
}

function renderServerChanSettings(settings) {
  if (serverChanFormDirty) return;
  els.serverChanEnabled.checked = Boolean(settings.enabled);
  els.serverChanSendKey.value = "";
  els.serverChanSendKey.placeholder = settings.hasSendKey
    ? `??? ${settings.sendKeyPreview}??????? SendKey`
    : "??? Server? SendKey";
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

function readDismissedAlertLogKeys() {
  try {
    return JSON.parse(localStorage.getItem("dismissedAlertLogKeys") || "[]");
  } catch {
    return [];
  }
}

function writeDismissedAlertLogKeys() {
  localStorage.setItem("dismissedAlertLogKeys", JSON.stringify([...dismissedAlertLogKeys]));
}

function renderSamplingInterval(config = {}) {
  const seconds = String(Math.max(10, Number(config.schedule?.intervalSeconds || 60)));
  if (![...els.intervalSeconds.options].some((option) => option.value === seconds)) {
    const option = document.createElement("option");
    option.value = seconds;
    option.textContent = `${seconds} ?`;
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
  if (!mute) return "????";
  if (mute.mode === "permanent") return "???????";
  return `????? ${formatTime(mute.until)}`;
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
    <text class="mini-label end" x="${width - pad.right}" y="14">${escapeSvg(formatNumber(currentFlow))} Mbps ? ${escapeSvg(formatPercent(item.bandwidthUsagePercent))}</text>
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
    <span>${escapeHtml(formatPercent(nearest.percent))} ? ${escapeHtml(formatChartTime(nearest.checkedAt))}</span>
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

function onAlertLogAction(event) {
  const button = event.target.closest("button[data-action='dismiss-alert-log']");
  if (!button) return;
  dismissAlertLog(button.dataset.alertKey);
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
  els.saveMessage.textContent = "????????...";
  try {
    const hidden = latestPayload?.nodeSettings?.hiddenNodeUuids || [];
    const fullOrder = [...uuids, ...hidden.filter((uuid) => !uuids.includes(uuid))];
    const res = await fetch("/api/node-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuids: fullOrder })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "??????");
    latestPayload.nodeSettings = body.nodeSettings;
    render(latestPayload);
    els.saveMessage.textContent = "???????";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  }
}

async function copyUuid(uuid, button) {
  try {
    await navigator.clipboard.writeText(uuid);
    flashButton(button, "???");
  } catch {
    fallbackCopy(uuid);
    flashButton(button, "???");
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
  els.saveMessage.textContent = "??????????...";
  try {
    const alerts = getTileAlertDraft(uuid);
    const res = await fetch("/api/node-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, alerts })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "????");
    latestPayload.nodeSettings = body.nodeSettings;
    tileAlertDrafts.set(uuid, cloneAlerts(body.nodeSettings?.nodeAlerts?.[uuid] || []));
    flippedTileUuid = "";
    render(latestPayload);
    els.saveMessage.textContent = "?????????";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function saveTileMonitor(uuid, button) {
  button.disabled = true;
  els.saveMessage.textContent = "????????...";
  try {
    const monitor = getTileMonitorDraft(uuid);
    const res = await fetch("/api/node-monitor-setting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, monitor })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "????");
    latestPayload.nodeSettings = body.nodeSettings;
    tileMonitorDrafts.set(uuid, { ...(body.nodeSettings?.nodeMonitors?.[uuid] || monitor) });
    flippedTileUuid = "";
    render(latestPayload);
    els.saveMessage.textContent = "???????";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function clearTileMonitor(uuid, button) {
  button.disabled = true;
  els.saveMessage.textContent = "????????...";
  try {
    const res = await fetch("/api/node-monitor-setting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, monitor: null })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "????");
    latestPayload.nodeSettings = body.nodeSettings;
    tileMonitorDrafts.delete(uuid);
    flippedTileUuid = "";
    render(latestPayload);
    els.saveMessage.textContent = "???????";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function addNodeAlertRule() {
  if (!selectedNodeUuid) {
    els.nodeAlertMessage.textContent = "????????";
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
    els.nodeAlertMessage.textContent = "????????";
    return;
  }
  els.saveNodeAlerts.disabled = true;
  els.nodeAlertMessage.textContent = "??????...";
  try {
    const res = await fetch("/api/node-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid: selectedNodeUuid, alerts: draftNodeAlerts })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "????");
    latestPayload.nodeSettings = body.nodeSettings;
    draftNodeAlerts = cloneAlerts(body.nodeSettings?.nodeAlerts?.[selectedNodeUuid] || []);
    render(latestPayload);
    els.nodeAlertMessage.textContent = "???????";
  } catch (error) {
    els.nodeAlertMessage.textContent = error.message;
  } finally {
    els.saveNodeAlerts.disabled = false;
  }
}

async function saveServerChanSettings() {
  els.saveServerChanSettings.disabled = true;
  els.serverChanMessage.textContent = "???? Server???...";
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
    if (!res.ok) throw new Error(body.error || "????");
    latestPayload.config = body.config;
    latestPayload.serverChanSettings = body.serverChanSettings;
    serverChanFormDirty = false;
    render(latestPayload);
    els.serverChanMessage.textContent = "Server??????";
  } catch (error) {
    els.serverChanMessage.textContent = error.message;
  } finally {
    els.saveServerChanSettings.disabled = false;
  }
}

async function updateNodeVisibility(uuid, hidden, button) {
  button.disabled = true;
  els.saveMessage.textContent = hidden ? "??????..." : "??????...";
  try {
    const res = await fetch("/api/node-visibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, hidden })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "????");
    latestPayload.nodeSettings = body.nodeSettings;
    syncLocalNodeVisibility(uuid, hidden);
    render(latestPayload);
    els.saveMessage.textContent = hidden ? "?????" : "?????";
  } catch (error) {
    els.saveMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function syncLocalNodeVisibility(uuid, hidden) {
  const resources = latestPayload?.state?.latest?.resources || [];
  for (const resource of resources) {
    if (resource.uuid === uuid) resource.uiHidden = hidden;
  }
}

async function updateNodeAlertMute(uuid, duration, button) {
  button.disabled = true;
  els.saveMessage.textContent = "??????????...";
  try {
    const res = await fetch("/api/node-alert-mute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid, duration })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "??????????");
    latestPayload.nodeSettings = body.nodeSettings;
    render(latestPayload);
    els.saveMessage.textContent = duration === "none" ? "?????" : "?????";
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
  els.saveMessage.textContent = "???????????";
}

function dismissAlertLog(logKey) {
  if (!logKey) return;
  const alert = buildAlertLogs(latestPayload?.state?.activeAlerts || [], latestPayload?.history || [])
    .find((item) => item.logKey === logKey);
  dismissedAlertLogKeys.add(logKey);
  if (alert?.live && alert.nodeUuid && alert.id) {
    dismissedNodeAlertIds.add(alert.id);
    writeDismissedNodeAlertIds();
  }
  writeDismissedAlertLogKeys();
  render(latestPayload);
  els.saveMessage.textContent = "???????";
}

function clearAlertLogs() {
  const logs = buildAlertLogs(latestPayload?.state?.activeAlerts || [], latestPayload?.history || [])
    .filter((alert) => !dismissedAlertLogKeys.has(alert.logKey));
  if (!logs.length) return;
  for (const alert of logs) {
    dismissedAlertLogKeys.add(alert.logKey);
    if (alert.live && alert.nodeUuid && alert.id) dismissedNodeAlertIds.add(alert.id);
  }
  writeDismissedAlertLogKeys();
  writeDismissedNodeAlertIds();
  render(latestPayload);
  els.saveMessage.textContent = "?????????";
}

async function saveSamplingInterval() {
  if (!latestPayload?.config) return;
  const intervalSeconds = Math.max(10, Number(els.intervalSeconds.value || 60));
  els.intervalSeconds.disabled = true;
  els.saveMessage.textContent = "????????...";
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
    if (!res.ok) throw new Error(body.error || "????????");
    latestPayload.config = body;
    renderSamplingInterval(body);
    els.saveMessage.textContent = `???????? ${formatInterval(intervalSeconds)}`;
  } catch (error) {
    els.saveMessage.textContent = error.message;
    renderSamplingInterval(latestPayload.config);
  } finally {
    els.intervalSeconds.disabled = false;
  }
}

async function runAction(url, button, successText, messageEl = els.saveMessage) {
  button.disabled = true;
  messageEl.textContent = "????...";
  try {
    const res = await fetch(url, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "????");
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
    els.loginMessage.textContent = "????????";
    return;
  }

  els.loginButton.disabled = true;
  els.loginMessage.textContent = "???????????...";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "????");
    els.loginPassword.value = "";
    els.loginMessage.textContent = `${body.message}?HTTP ${body.metrics?.httpStatus ?? "-"}`;
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

function formatCurrency(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFlowGb(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "-";
  return `${number.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} G`;
}

function formatSettlementUsage(incomeItem = {}, resource = null) {
  const settlementMbps = Number(incomeItem.flowGb || 0) * 1000;
  const bandwidthMbps = Number(resource?.bandwidthMbps || 0);
  if (!Number.isFinite(settlementMbps) || !Number.isFinite(bandwidthMbps) || bandwidthMbps <= 0) return "-";
  return formatPercent(percent(settlementMbps, bandwidthMbps));
}

function calculateMonthlyUnitPrice(item = {}) {
  const income = Number(item.incomeYuan || 0);
  const flow = Number(item.flowGb || 0);
  if (!Number.isFinite(income) || !Number.isFinite(flow) || flow <= 0) return 0;
  return round((income / flow) * daysInMonth(item.date), 2);
}

function daysInMonth(dateKey) {
  const [year, month] = String(dateKey || "").split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 30;
  return new Date(year, month, 0).getDate();
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

function formatTaxRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "6%";
  return formatPercent(number > 1 ? number : number * 100);
}

function formatInterval(seconds) {
  const value = Number(seconds || 0);
  if (value >= 60 && value % 60 === 0) return `${value / 60} ??`;
  return `${value} ?`;
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
