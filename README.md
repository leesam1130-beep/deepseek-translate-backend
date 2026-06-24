# SemaTranslate / DeepSeek Translate Backend

为 **达累斯萨拉姆（Dar es Salaam）** WhatsApp 商务聊天提供翻译服务。

- **主语言**：斯瓦希里语、英语、法语（+243 刚果法语客户）
- **口语词库**：`colloquial-glossary.json`（Vp/Ngp/Bei 等 Dar 常见口语，默认启用）
- **前后文**：来信批量翻译自动附带最近 5 条对话；中文出站附带客户最近消息作参考
- **AI**：DeepSeek 主 + OpenAI 备

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY 和 OPENAI_API_KEY
npm start
```

访问 `http://localhost:3000/api/health` 应返回 `{"ok":true,"hasKey":true,"provider":"deepseek",...}`。

## 与 SemaTranslate 扩展配对

| 项目 | 路径（本机） |
|---|---|
| SemaTranslate 扩展 | `../SemaTranslate` |
| 本后端 | 当前目录 `deepseek-translate-backend` |

扩展 `config.js` 中的 `SEMA_BACKEND_BASE_URL` 必须等于 Railway **Public Domain**（无末尾斜杠）。配对说明见扩展目录 `BACKEND.md`。

### 修改后部署

```bash
git add .
git commit -m "fix: 描述改动"
git push origin main
```

Railway 监听 `main` 分支自动 redeploy。部署完成后可用：

```bash
curl https://deepseek-translate-backend-production.up.railway.app/api/health
```

## 部署到 Railway

1. 推送本仓库到 GitHub
2. Railway → New Project → Deploy from GitHub
3. Variables 添加：
   - `DEEPSEEK_API_KEY` = `sk-...`（主 provider）
   - `OPENAI_API_KEY` = `sk-...`（容灾备份，推荐填）
   - `SEMA_PRIMARY_PROVIDER` = `deepseek`（默认）
   - `SEMA_ALLOWED_USERS` = `alice,bob`（可选，用户名白名单）
   - `SEMA_USER_QUOTAS` = `alice:500000,bob:200000`（可选，月度 token 配额）
4. Generate Domain 拿到公网 URL
5. 把 URL 填到 SemaTranslate 扩展的 `config.js`

## API

| 方法 + 路径 | 用途 |
|---|---|
| `GET /api/health` | 健康检查 + provider 模型目录 |
| `GET /api/usage` | 当前用户本月用量（需 `X-SEMA-User` 头） |
| `GET /api/admin/usage` | 所有用户用量（需 `SEMA_ADMIN_USERS` 授权） |
| `POST /api/translate` | 中文 → 客户语言 |
| `POST /api/batch-translate-incoming` | 批量来信 → 中文 |

### 认证头

扩展请求需带：
- `X-SEMA-User: <username>`（推荐）
- 或 `X-GWELL-User: <username>`（向后兼容）

### 用户用量 / 配额

- 每次翻译自动累计 token 到 `data/usage.json`（按月分桶）
- `SEMA_USER_QUOTAS` 设置月度上限，超额返回 `429 QUOTA_EXCEEDED`
- 后续可迁移到数据库，接口不变

## 与 GWELL 后端的区别

| | GWELL 后端 | 本后端 |
|---|---|---|
| 主 provider | Gemini | **DeepSeek** |
| 备 provider | OpenAI | OpenAI |
| 品牌 | GWELL CRM | SemaTranslate |
| 用量追踪 | 仅日志 | 文件持久化 + 配额 |
