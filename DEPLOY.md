# 班味浓度检测 · 线上部署说明

## 一、公开网址

- 测评页面：<https://banwei-quiz-54989.app.workbuddy.host/>
- 管理后台：<https://banwei-quiz-54989.app.workbuddy.host/admin.html>

## 二、部署架构

```
浏览器（手机/平板/电脑）
   │  静态资源（HTML/CSS/JS）
   ▼
前端静态托管（本目录 banwei-quiz-online，云端沙箱静态站点）
   │  业务请求（cloud SDK → RPC）
   ▼
WorkBuddy 云服务数据面  /.cloud/database/rest/rpc/*
   │  8 个 SECURITY DEFINER 函数（唯一服务端逻辑层）
   ▼
托管 PostgreSQL（7 张表，全部启用 RLS 且零策略 = 浏览器无法直读直写）
```

- **前端**：`banwei-quiz-online/` 目录，纯静态站点，通过应用发布能力上线，无需构建。
- **后端**：无独立服务器。后端逻辑全部在数据库内的 8 个 PL/pgSQL `SECURITY DEFINER` 函数中
  （`bw_verify` / `bw_submit` / `bw_result` / `bw_admin_login` / `bw_admin_generate` /
  `bw_admin_list` / `bw_admin_disable` / `bw_admin_set_password`），
  加辅助函数 `bw_admin_ok`。行锁（`SELECT … FOR UPDATE`）保证并发扣次不超卖。
- **数据库**：WorkBuddy 云服务托管 PostgreSQL。表：`bw_passwords`（密码）、`bw_results`（测评结果）、
  `bw_tokens`（答题会话）、`bw_settings`（管理员密码哈希等）、`bw_admin_sessions`（管理员会话）、
  `bw_weights`（48 行选项权重）、`bw_rate`（限流计数）。

## 三、安全模型（为什么前端拿不到敏感信息）

1. 浏览器只持有 `publishableKey`（公开标识，无权限语义），见 `config.js`。
2. 7 张表 RLS 全部启用且**不授予任何策略** → 浏览器直读/直写一律返回空集或 42501。
3. 唯一入口是 8 个 RPC 函数（已 `REVOKE ALL FROM PUBLIC`，仅授予 `anon, authenticated`）。
4. 管理员身份 = 32 位十六进制会话 token，存 `bw_admin_sessions`（12 小时过期），
   每个管理函数内部先 `bw_admin_ok(token)` 校验。
5. 管理员密码只存 SHA-256 哈希；登录失败限流 10 次/分钟；改密会吊销其他设备会话。
6. 计分逻辑（权重表 `bw_weights` + 分段线性浓度映射）在数据库函数内，前端拿不到权重。

## 四、环境变量 / 密钥

线上版不需要服务器端密钥：

| 配置 | 位置 | 说明 |
|---|---|---|
| `endpoint` | `config.js` | 云服务数据面地址（与站点同域） |
| `publishableKey` | `config.js` | 公开标识，可进前端 |
| 管理员密码 | 数据库 `bw_settings.admin_pwd_sha256` | 只存哈希，初始值 `banwei-admin-2026`，**上线后请在后台立即修改** |

本地版（`banwei-quiz/`）的 `.env`（`PORT` / `ADMIN_PASSWORD` / `SESSION_SECRET`）只用于本地 Node 服务器，与线上版无关。

## 五、如何更新网站

1. 修改 `banwei-quiz-online/` 下的任意文件（`index.html`、`app.js`、`style.css`、`questions-data.js`、`results-data.js` 等）。
2. 重新执行一次「发布」（部署该目录），链接保持不变，内容即刻更新。
3. 改动**数据库函数或数据**时不涉及前端发布，直接在云数据库执行 SQL 即可生效。

## 六、管理后台初始化

1. 打开 `/admin.html`，初始密码 `banwei-admin-2026`。
2. 登录后第一件事：在「修改管理员密码」中改成自己的密码（至少 8 位；改完其他设备会话自动失效）。
3. 「批量生成密码」：填数量 + 每个密码可用次数 → 生成；支持搜索、导出 CSV、禁用。

## 七、线上测试报告（2026-10-17 实测）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 首页 / 静态资源（app.js、style.css、admin.html、config.js） | 全部 200 ✅ |
| 2 | 跨域 RPC（真实站点 Origin 调用 `bw_verify`） | 200 正常 ✅ |
| 3 | 密码校验：合法 / 格式错误 / 不存在 / 已禁用 / 次数用完 | 全部返回正确文案 ✅ |
| 4 | 提交答案并扣次（4 次密码连测 4 次 → 4/3/2/1/0） | 精确扣减 ✅ |
| 5 | 同 token 重放提交 | 幂等返回原结果，不重复扣次 ✅ |
| 6 | 非法答案（缺题/越界）、伪造 token 提交 | 均被拒绝 ✅ |
| 7 | **6 路并发提交（密码仅 3 次）** | 恰好 3 成功 3 拒绝，剩余次数归 0，无超卖 ✅ |
| 8 | 结果分享链接（`?r=<id>`，64bit 随机 id） | 可打开，不含密码/管理员信息/权重 ✅ |
| 9 | 管理员登录：错误密码 / 正确密码 / 失败限流 | 正常，10 次/分钟限流 ✅ |
| 10 | 批量生成 / 列表统计 / 禁用密码 / 导出 | 正常 ✅ |
| 11 | 修改管理员密码：旧密码失效、新密码可登录、**其他会话吊销** | 正常（已修复并复测）✅ |
| 12 | 未授权直读 `bw_passwords` / `bw_results` | 返回空集（RLS 拦截）✅ |
| 13 | 未授权直改剩余次数（PATCH） | 42501 permission denied ✅ |
| 14 | 无 token / 伪造 token 调管理接口 | 「未登录或会话已过期」✅ |
| 15 | 手机视口（390×844）端到端：门→答题→结果→后台 | 全流程通过，无横向溢出，无 JS 报错 ✅ |

测试中消耗的密码：`BW-SEXN-88Z4`、`BW-WJEP-DSZY` 已用完；`BW-2ATB-6CCF` 已用 1 次。
可用测试密码（每个 3 次）：`BW-246A-4B3P` `BW-KSEM-3SYZ` `BW-V4Z7-JL45` `BW-VZ5C-PBZ7` `BW-TTUV-7B3J` `BW-4YRJ-6JU2` `BW-XY3R-XT8S` `BW-GUB8-L32W` `BW-UZ39-3BZD` `BW-A2VB-Y6MA`。

## 七点五、测试便利：链接参数自动填入密码

| 参数 | 行为 |
|---|---|
| `?c=BW-XXXX-XXXX` | 自动填入测评密码，需手动点击「验证密码」 |
| `?c=BW-XXXX-XXXX&auto=1` | 自动填入、自动验证并直接进入答题 |
| `admin.html?pwd=<管理密码>` | 自动填入管理员密码（不自动登录） |

安全设计：验证成功后地址栏参数会被立即清除，避免复制地址分享时把密码带出去；密码不出现在页面源码，仅由链接持有者传入。专用测试密码 `BW-TEST-2222`（50 次）已预置，正式密码不会被测试耗尽。

## 八、GitHub 托管

- **仓库**：<https://github.com/senlinbird/banwei-quiz>（public，main 分支）
- **GitHub Pages**：<https://senlinbird.github.io/banwei-quiz/>（source：`main` 分支 `/docs` 目录，入口页自动跳转到正式站点）
- **为什么运行站点不在 GitHub Pages**：云服务数据面对请求 `Origin` 做精确匹配，只接受应用绑定的保留域名；
  从 `*.github.io` 发起的 RPC 会返回 `403 access_denied`（实测）。这是平台级安全策略。
- **更新方法**：修改本目录源码后重新推送到 `main`（Pages 会自动重建 `docs/`），
  运行站点则需在部署侧重新发布（见第五节）。
- **本仓库还包含** `selfhost/`：零依赖 Node.js 自托管版，`npm start` 即可在自有服务器运行全部功能。

## 九、本地版与线上版的关系

- `banwei-quiz/`：Node 零依赖版（server.js + JSON 文件存储），适合本地演示，功能等价。
- `banwei-quiz-online/`：线上版（静态前端 + 云数据库 RPC），当前公网运行的就是它。
- 两版共用同一套题库文案与计分算法；线上版计分在数据库函数内完成。
