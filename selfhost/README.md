# 班味浓度检测 · 测评网站

零依赖 Node.js 测评网站：服务端计分、密码次数管控、管理后台、结果分享长图，开箱即用。

## 快速开始

```bash
# 1. 配置环境变量（首次）
cp .env.example .env   # Windows: copy .env.example .env
# 编辑 .env：修改 ADMIN_PASSWORD 和 SESSION_SECRET

# 2. 启动（无需 npm install，无任何第三方依赖）
node server.js

# 3. 访问
#    测评页面  http://localhost:3000/
#    管理后台  http://localhost:3000/admin
```

首次启动会自动预置演示密码 `BW-8888-8888`（10 次），正式使用请在后台生成并删除/禁用它。

## 功能清单

| 用户端 | 说明 |
|---|---|
| 密码门 | 输入测评密码验证通过后开始，服务端校验 |
| 答题 | 12题逐题作答，支持上一题/修改答案/进度显示，选项即存可回退 |
| 计分 | **服务端计分**（四维 W/E/S/R → 班味浓度 3%~99% → 11种结果），前端拿不到任何分值 |
| 结果页 | 浓度大字、成分条形图、综合评价/行为/优势/短板/案例/建议完整文案 |
| 长图 | Canvas 原生生成 750px 分享长图；支持系统分享（保存到相册）/下载/长按保存 |
| 分享链接 | `/r/<结果ID>` 直达结果页，不暴露密码与任何他人数据 |

| 管理后台（/admin） | 说明 |
|---|---|
| 登录 | 密码登录，HMAC 签名 HttpOnly Cookie，12小时有效 |
| 批量生成 | 自定义数量与每密码次数，格式 `BW-XXXX-XXXX`（去混淆字符集） |
| 列表/搜索 | 密码、总次数、剩余次数、状态、创建时间，实时统计 |
| 禁用 | 单个禁用，禁用后校验/提交均被拒 |
| 导出 | 一键导出 CSV（含 BOM，Excel 直接打开不乱码） |

## 并发、重复请求与异常处理

- **提交幂等**：开始答题前领取一次性提交令牌（`/api/prepare`，30分钟有效）。提交必须携带令牌；
  成功后令牌与结果绑定，**网络超时重试/双击提交会返回同一结果，绝不重复扣次数**（锁内二次确认，并发双击也安全）。
- **扣减原子性**：同一密码的提交串行执行（进程内互斥锁），次数扣减与结果落盘同事务完成。
- **限流防暴力**：按 IP 滑动窗口限流——密码校验 20次/分、提交 12次/分、管理员登录 10次/分，超限返回 429。
- **异常输入**：密码格式（`BW-XXXX-XXXX`）、答案数组（12个0-3整数）、令牌归属均严格校验；
  JSON 解析容错、请求体 64KB 上限、未知 API 返回 JSON 404、静态路径防目录穿越。
- **网络错误**：前端所有请求带 8~15 秒超时与友好文案；断网/恢复有 toast 提醒；
  提交失败时答案保留在页面，可直接重试；题目加载失败提供点击重试；结果页加载失败提供刷新重试。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/verify` | 校验密码 `{code}`，不扣次数，限流 20/分 |
| GET | `/api/quiz` | 获取题目（已脱敏，无分值） |
| POST | `/api/prepare` | 领取提交令牌 `{code}`，返回 `{token}` |
| POST | `/api/submit` | 提交 `{code, answers[12], token}`，幂等，限流 12/分 |
| GET | `/api/result?id=` | 按结果ID读取报告（分享页数据源） |
| POST | `/api/admin/login` / `logout` | 管理员登录/登出，登录限流 10/分 |
| GET | `/api/admin/passwords?q=` | 密码列表与统计 |
| POST | `/api/admin/passwords/generate` | 批量生成 `{count, attempts}` |
| POST | `/api/admin/passwords/disable` | 禁用 `{codes:[...]}` |
| GET | `/api/admin/export` | 导出 CSV |

## 核心功能测试清单

| # | 测试项 | 操作 | 预期 |
|---|--------|------|------|
| 1 | 正常全流程 | 输入有效密码 → 答完12题 → 提交 | 生成结果与长图，密码剩余次数 -1 |
| 2 | 无效密码 | 输入 `BW-0000-0000` | 「密码不存在，请检查后重试」 |
| 3 | 密码格式错误 | 输入 `123` | 「密码格式应为 BW-XXXX-XXXX」 |
| 4 | 次数耗尽 | 用完次数后再验证 | 「该密码的测评次数已用完」 |
| 5 | 已禁用密码 | 后台禁用后验证/提交 | 「该密码已被禁用，请联系管理员」 |
| 6 | 重复提交幂等 | 提交成功后用同一 token 再提交 | 返回同一 resultId，`duplicate:true`，次数不变 |
| 7 | 并发安全 | 10 路并发提交 3 次配额 | 恰好成功 3 次，状态变 `used` |
| 8 | 提交限流 | 1分钟内提交超12次 | 429「请求太频繁了」 |
| 9 | 非法答案 | answers 缺项/超界/非整数 | 「答卷不完整或有误」 |
| 10 | 令牌缺失/伪造 | 不带 token 或伪造 token 提交 | 「答题会话已失效，请重新验证密码」 |
| 11 | 网络超时 | 断网后点击提交 | 友好提示，答案保留，恢复后重试不重复扣次 |
| 12 | 未登录访问后台接口 | 直接请求 `/api/admin/*` | 401 |
| 13 | 管理员登录限流 | 1分钟内错密登录超10次 | 429 |
| 14 | 分享链接 | 打开 `/r/<结果ID>` | 直达报告，页面无密码信息 |

## 公开部署步骤

本应用零依赖，任何能常驻运行 Node.js 18+ 的环境均可部署（需持久磁盘保存 `data/db.json`）。

**方式一：自有云服务器（推荐）**

```bash
# 1. 上传项目目录到服务器（如 /opt/banwei-quiz），不要上传 data/ 与 .env
# 2. 安装 Node.js 18+
# 3. 配置环境变量
cp .env.example .env && vi .env
#    必改：ADMIN_PASSWORD（强密码）、SESSION_SECRET（长随机串）、PORT
# 4. 用 pm2 常驻
npm i -g pm2
pm2 start server.js --name banwei-quiz && pm2 save && pm2 startup
# 5. Nginx 反向代理 + HTTPS（分享/剪贴板功能需要 HTTPS）
#    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
#    证书：certbot --nginx 或云厂商免费证书
```

**方式二：Serverless/容器平台（Render、Railway、轻量云等）**

- 启动命令 `node server.js`，健康检查 `/`
- 挂载持久磁盘到 `data/`（否则重启丢数据）
- 环境变量在平台控制台配置（同上三项）

**上线检查清单**

- [ ] 已修改 `ADMIN_PASSWORD` 与 `SESSION_SECRET`
- [ ] 已禁用/删除演示密码 `BW-8888-8888`
- [ ] HTTPS 已启用（分享与剪贴板 API 在非 HTTPS 移动浏览器受限）
- [ ] 已备份 `data/db.json`（定期 cron 备份即可）

## 数据存储与表结构

存储于 `data/db.json`（默认目录，可用 `DATA_DIR` 修改），结构：

```jsonc
{
  "passwords": [
    {
      "code": "BW-AB2C-3DEF",   // 唯一测评密码
      "total": 3,               // 总次数
      "attemptsLeft": 2,        // 剩余次数（服务端扣减）
      "status": "active",       // active | used | disabled
      "createdAt": "2026-10-16T15:00:00.000Z"
    }
  ],
  "results": [
    {
      "id": "a1b2c3d4e5f6a7b8", // 结果ID，分享链接 /r/<id>
      "final": 72,              // 最终班味浓度
      "W": 15, "E": 9, "S": 11, "R": 3,  // 四维得分
      "resultKey": "mengli",    // 结果类型
      "answers": [2,3,0,2,3,3,1,0,2,0,2,2], // 选项记录
      "createdAt": "..."        // 注意：不存储密码，不关联用户身份
    }
  ]
}
```

初始化：无需手工建表，首次运行自动创建目录与演示密码。备份即备份 `data/db.json`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | 3000 | 服务端口 |
| `ADMIN_PASSWORD` | **生产必填** | admin123（打印警告） | 管理后台登录密码 |
| `SESSION_SECRET` | **生产必填** | 随机（重启失效） | 管理员会话签名密钥 |
| `DATA_DIR` | 否 | `./data` | 数据目录 |
| `MAX_ATTEMPTS` | 否 | 3 | 新密码默认次数 |

安全要求：所有密钥只放在服务端环境变量或 `.env`（请勿提交到 git / 放入前端代码）；`.env` 建议加入 `.gitignore`。

## 项目结构

```
banwei-quiz/
├── server.js          # 服务端：API + 静态资源 + 数据层 + 会话
├── data-quiz.js       # 题库与计分（仅服务端，含分值）
├── data-results.js    # 11种结果判定与完整文案（仅服务端）
├── public/
│   ├── index.html     # 测评页（密码门/答题/结果/长图）
│   ├── app.js         # 用户端逻辑 + Canvas 长图生成
│   ├── style.css      # 移动端优先样式
│   ├── admin.html     # 管理后台页面
│   └── admin.js       # 管理后台逻辑
├── data/db.json       # 运行时自动生成
├── .env.example       # 环境变量模板
└── package.json
```
