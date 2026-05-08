# 资源动态监控

一个轻量级监控面板，用于定时监控 `https://cloud.tingyutech.com/jusha/resource/all` 对应的资源数据接口，提取指标，在规则命中时发送报警邮件。

## 启动

```powershell
node server.js
```

打开 `http://localhost:3000`。

## Docker

构建镜像：

```bash
docker build -t jusha-dashboard .
```

运行容器：

```bash
docker run -d --name jusha-dashboard -p 3000:3000 --env-file .env -v jusha-dashboard-data:/app/data jusha-dashboard
```

打开 `http://localhost:3000`。`data` 目录建议挂载为 volume，用来保留运行状态、节点设置和历史数据。

如果当前终端仍然优先命中 Codex 自带的 `node.exe` 并提示“拒绝访问”，可以直接使用完整路径启动：

```powershell
& 'C:\Program Files\nodejs\node.exe' server.js
```

## 配置

核心配置在 `config/monitor.config.json`，也可以在页面右侧直接编辑并保存。

已确认页面本身是前端渲染的控制台壳，真实资源列表接口是：

```text
https://cloud.tingyutech.com/api/jusha/machine/all/list?page=1&size=20
```

未登录时该接口会返回 `code: 9999` 和“未登录(1)”，所以正式监控需要配置登录 Cookie。

常用字段：

- `target.url`: 被监控的页面地址。
- `target.headers`: 抓取时附加的请求头。
- `schedule.intervalSeconds`: 抓取间隔。
- `extractors`: 指标提取器，支持 `regex`、`contains`、`textLength`、`jsonPath`。
- `rules`: 报警规则，支持 `equals`、`notEquals`、`greaterThan`、`greaterOrEqual`、`lessThan`、`lessOrEqual`、`contains`、`notContains`、`exists`、`missing`。
- `email.enabled`: 是否启用邮件报警。
- `email.cooldownSeconds`: 同一规则的邮件冷却时间。

## 登录态

页面里已经提供“登录账号”功能。输入庭宇云账号密码后，服务会调用 `https://cloud.tingyutech.com/api/basic/login`，只把返回的 Cookie 写入本地 `.env`，不会保存账号密码。

也可以手动在 `.env` 中设置浏览器登录后的 Cookie：

```env
MONITOR_COOKIE=sessionid=replace-me; other=value
MONITOR_USER_AGENT=Mozilla/5.0
```

## 邮件报警

复制 `.env.example` 为 `.env`，填写 SMTP：

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=alerts@example.com
SMTP_PASS=replace-me
ALERT_FROM=alerts@example.com
ALERT_TO=ops@example.com
```

然后将 `config/monitor.config.json` 里的 `email.enabled` 改为 `true`。

## 适配目标页面

默认配置会先检查：

- HTTP 状态是否为 200。
- API 是否返回 `success: true`。
- 资源列表总数是否为 0。这个规则默认关闭，确认登录态和接口字段后再启用。

资源列表会抓取并展示：

- `status` / `online`: 状态。
- `uuid`: UUID。
- `/api/jusha/machine/monitor/{uuid}`: 节点曲线数据，使用 `machineMonitorData[].tx5` 按 5 分钟字节量换算为 Mbps。
- `maxBandwidth`: 带宽，按 Mbps 展示，并用于计算当前流量占比。
- `descSub`: 备注。

默认只包含 `machineStatusMap` 为 `normal` 的资源，这和网站“未隐藏”列表保持一致。可在 `resourceFilter.includeMachineStatusMap` 里调整。

节点会以磁贴形式展示，每个节点都有独立流量曲线，并标注当前实时流量占该节点带宽的百分比。

真正的业务规则需要根据页面实际内容调整 `extractors` 和 `rules`。例如页面里有 `库存：12` 这种文字，可以增加：

```json
{
  "key": "stock",
  "label": "库存",
  "type": "regex",
  "pattern": "库存[:：]\\s*(\\d+)",
  "flags": "i",
  "valueType": "number"
}
```

再增加规则：

```json
{
  "id": "stock-low",
  "enabled": true,
  "metric": "stock",
  "operator": "lessThan",
  "value": 10,
  "severity": "critical",
  "message": "库存低于阈值"
}
```
