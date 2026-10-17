# 班味浓度检测 · 职场人格测评

一个面向年轻职场人的趣味心理学测评产品：12 道真实职场场景题，四维模型（工作渗透 / 情绪损耗 / 社交防御 / 生活修复）计分，输出 11 种人格化结果，支持生成长图分享。

- **在线体验**：<https://banwei-quiz-54989.app.workbuddy.host/>
- **GitHub Pages 入口**：<https://senlinbird.github.io/banwei-quiz/>
- **管理后台**：`/admin.html`（需管理员密码，由部署方持有）

## 为什么线上入口不在 GitHub Pages

这是一个**前端静态 + 云端数据库 RPC** 的架构：浏览器只负责渲染，所有密码校验、次数扣减、计分、管理操作都在数据库的
`SECURITY DEFINER` 函数里完成（前端拿不到权重表和任何敏感数据）。

云服务的数据面对请求 `Origin` 做**精确匹配**，只接受应用绑定的保留域名。因此页面必须从该域名加载，
否则浏览器发起的 RPC 会被 `403 access_denied` 拒绝。GitHub Pages（`*.github.io`）属于不同 Origin，
无法直连数据面 —— 这是平台级安全策略，不是配置遗漏。

所以本仓库承担的是**源码托管与版本管理**，GitHub Pages 提供一个中转入口页；实际运行站点由云服务应用域名承载。

## 目录结构

```
.
├── index.html          # 测评页（密码门 → 答题 → 结果）
├── app.js              # 前端逻辑：RPC 调用、答题状态机、Canvas 长图生成
├── admin.html / admin.js  # 管理后台：登录、批量生成密码、查询、导出、禁用、改密
├── style.css           # 移动端优先样式
├── config.js           # 云端 endpoint 与 publishableKey（公开标识，无权限语义）
├── questions-data.js   # 12 道题（不含权重，权重在数据库内）
├── results-data.js     # 11 种结果的完整文案
├── docs/index.html     # GitHub Pages 入口页
└── selfhost/           # 零依赖 Node.js 自托管版（JSON 文件存储），可完全离线运行
```

## 技术架构

```
浏览器 ──静态资源──▶ 静态托管
   └──── RPC (cloud SDK) ────▶ 云数据库 8 个 SECURITY DEFINER 函数 ──▶ PostgreSQL
```

- **安全边界**：7 张表全部启用 RLS 且不授予任何策略，浏览器直读直写一律被拒（`42501`）；
  唯一入口是授予 `anon` 的 8 个函数。
- **并发正确性**：`SELECT … FOR UPDATE` 行锁 + 一次性提交 token，保证并发下不超卖、重放不重复扣次。
- **管理员鉴权**：32 位会话 token 存服务端表（12 小时过期），每个管理函数内部先校验；
  改密时吊销其他设备会话；登录失败限流 10 次/分钟。

## 数据模型

| 表 | 用途 |
|---|---|
| `bw_passwords` | 测评密码、总次数、剩余次数、状态 |
| `bw_results` | 测评结果（维度分、浓度、结果类型） |
| `bw_tokens` | 答题会话 token（绑定密码与实际答案） |
| `bw_settings` | 管理员密码哈希等配置 |
| `bw_admin_sessions` | 管理员会话 |
| `bw_weights` | 48 行选项权重（计分数据，不出库） |
| `bw_rate` | 限流计数 |

## 自托管（不依赖云服务）

```bash
cd selfhost
cp .env.example .env      # 配置 PORT / ADMIN_PASSWORD / SESSION_SECRET
npm start                 # 默认 http://localhost:3210
```

零第三方依赖，数据存本地 JSON 文件，适合内网或自有服务器部署。

## 更新线上内容

1. 修改本仓库任意前端文件；
2. 在部署侧重新发布该目录（链接不变，内容即时更新）；
3. 若改动数据库函数/数据，直接执行 SQL 即可，无需重新发布前端。

## 许可

代码可自由用于学习与二次开发；测评文案与人格设定版权归作者所有。
