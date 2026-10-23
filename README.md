# ask-gemini-chat

> 「我已经厌倦了：“不是而是”，“这不是说”，“不等于”，“不自动等于”， “并不能说” 的gpt式屁话了，正好最有人味的ai gemini发了新argon，希望gpt能直接调用gemini」

`ask-gemini-chat` 是一个本地 MCP 服务。它让 GPT / Codex 等客户端直接把问题、本地文件和多轮上下文扔给网页版 Gemini Argon，适合拿来做长文写作、方案讨论或者听取第二意见。

登录时通过浏览器做一次会话确认，后续生成全部走直接的 HTTP 请求。没有页面自动化，不内置本地命令执行，也不开公共端口；模型返回的代码和文本都只作为纯数据处理。

## 安装与配置

### 交给 Agent 安装（推荐）

把[仓库](https://github.com/Crescenx/ask-gemini-chat)克隆到本地，用你的本地编程 Agent 打开项目目录，直接对它说：

> 按照 INSTALL.md 安装并配置这个工具，需要我登录时告诉我。

英文提示：

> Install and configure ask-gemini-chat for my agent. Follow INSTALL.md and verify that it works. Tell me when I need to sign in or confirm Chrome's connection.

Agent 会自动装好依赖、生成当前机器对应的 MCP 配置、检查登录状态并验证实际的 Argon 模型。你只需要在自己的 Chrome 里登录 Gemini，并在浏览器弹窗时点一次允许连接。完整安装手册见 [INSTALL.md](INSTALL.md)。

### 手动安装

环境要求：

- **Node.js 24+**
- **Python 3.10+**
- 拥有预设 **Argon** 模型访问权限的 Google 账号
- 已在 Linux / WSL 环境测试通过；原生 Windows 与 macOS 尚未验证

在仓库根目录执行：

```sh
npm run setup
npm run auth -- login
npm run doctor
npm run verify
npm run check
npm test
```

`npm run setup` 会创建带固定版本 `curl_cffi`（Chrome TLS 指纹）的 Python 环境，并在 `.runtime/mcp.json` 和 `.runtime/codex.toml` 生成包含本机绝对路径的配置文件（不含 Cookie）。未运行 setup 或未配置 `GEMINI_HTTP_PYTHON` 时，默认从 PATH 查找 `python3`（Windows 为 `python`）。程序支持 `HTTPS_PROXY` 等标准代理环境变量。本仓库仅支持从源码运行，未发布到 npm。

### MCP 客户端最小配置

将 `.runtime` 中生成的配置合并到你的客户端，或参考以下最小示例（请将两个路径替换为本机绝对路径）：

```json
{
  "mcpServers": {
    "ask-gemini-chat": {
      "command": "node",
      "args": ["/absolute/path/ask-gemini-chat/scripts/server.ts"],
      "env": {
        "GEMINI_HTTP_PYTHON": "/absolute/path/ask-gemini-chat/.venv/bin/python"
      }
    }
  }
}
```

请确保客户端环境中的 `node` 指向 Node 24+（必要时写绝对路径）。建议将客户端的单次工具调用超时设为至少 180 秒以保证文件上传完成；回答生成采用短轮询，不需要单次连接一直挂着等完全文生成。

## 登录与会话维护

执行 `npm run auth -- login` 进行本地会话同步。在 Chrome 144+ 中正常登录 Gemini，打开 `chrome://inspect/#remote-debugging` 开启远程调试，并在 Chrome 弹窗中点击允许（Allow）。脚本仅读取 `__Secure-1PSID` 和 `__Secure-1PSIDTS` 两个必要的会话 Cookie，通过 HTTP 验证后立即断开连接，不会索要密码或打印 Cookie。同步完成后即可关闭远程调试。详见 [登录步骤与账号选择](INSTALL.md#2-sign-in-through-the-users-browser)。

如果无法直接连接浏览器，可以使用该浏览器配置的默认 Google 账号登录 [Gemini](https://gemini.google.com) 后，从开发者工具中取出这两个 Cookie，存放在仓库外的私有 JSON 文件中：

```json
{
  "__Secure-1PSID": "YOUR_COOKIE_VALUE",
  "__Secure-1PSIDTS": "YOUR_COOKIE_VALUE"
}
```

然后手动导入并检查状态：

```sh
npm run auth -- import /absolute/private/path/cookies.json
npm run auth -- status
```

导入成功后请删除临时 JSON 文件。

**后台保活与重连：**

MCP 进程运行期间，会在启动时及之后每 10 分钟通过 HTTP 检查并维护一次会话，期间不访问或控制浏览器，也不发送生成请求。遇到临时网络故障会按 1 分钟到 1 小时的退避策略静默重试；客户端关闭或电脑休眠时维护暂停。若后台提示登录失效，或手动执行 `npm run auth -- refresh` 报 `LOGIN_REQUIRED`，重新运行 `npm run auth -- login` 即可恢复，无需重启 MCP 服务。

## MCP 工具与用法

服务仅公开三个工具：

| 工具名 | 用途 |
| --- | --- |
| `upload_gemini_file` | 上传本地文件（需绝对路径），返回 `file_id` |
| `ask_gemini_chat` | 提问，可附带 `file_ids` 或传入已有 `chat_id` 继续对话 |
| `get_gemini_result` | 传入 `run_id` 轮询生成进度或恢复中断前的请求结果 |

本项目不额外限制附件数量、文件大小、提示词字符数、输出长度或会话轮数，输入是否可用由 Gemini 决定。公开规则、Argon 实测结果和实现边界见 [BOUNDARIES.md](BOUNDARIES.md)。`wait_ms` 取值范围为 `0` 到 `25000`（默认 `20000`），仅控制单次轮询等待时间，不会终止生成。

文件上传先在系统临时目录（可用 `TMPDIR` 指定）流式生成私有快照并计算摘要，再由 libcurl 从磁盘上传；临时目录需要容纳该文件。上传结束会删除快照，复制期间源文件变化会返回 `FILE_CHANGED`。本地不再设置上传或生成的固定总时长；如果客户端自身超时，保留原 `request_id` 查询或重试。上游明确拒绝上传时返回 `UPLOAD_REJECTED` 和 HTTP 状态，传输中断后结果不明时返回 `OPERATION_UNCERTAIN`。

### 正常聊天与临时聊天

调用 `ask_gemini_chat` 时由 Agent 指定 `mode`：

- `mode: "normal"`（默认）：正常聊天，保留在 Google 的 Gemini 网页历史中，适合多轮深入讨论、长上下文复用，支持中断后从网页端历史核对并恢复结果。
- `mode: "temporary"`：临时聊天，不写入 Google 网页历史，适合一次性提问。支持携带附件、轮询结果以及凭保存的 `chat_id` 追问。

传入 `chat_id` 追问时省略 `mode` 即可自动继承原模式；强行修改模式会返回 `CHAT_MODE_MISMATCH`。

需要注意：`temporary` 仅控制不留 Google 网页历史，**本地数据库依然会保存提示词、回答、附件引用和请求 ID**，以便处理轮询、追问和去重。此外，临时聊天无法靠网页历史找回——如果流式响应中途断开且未能完整落盘，状态会变为 `uncertain` 并返回 `TEMPORARY_RESULT_UNRECOVERABLE`。此时不要继续轮询，也不要向该临时会话追加新问题。

### 调用示例

一次性临时提问：

```json
{"request_id":"quick-check-1","mode":"temporary","prompt":"Compute 23 + 48.","wait_ms":20000}
```

上传文件并开始正常多轮对话：

```json
{"request_id":"upload-orders-1","path":"/absolute/path/orders.csv"}
```

```json
{"request_id":"question-1","mode":"normal","prompt":"Compute the totals and explain the rules.","file_ids":["RETURNED_FILE_ID"],"wait_ms":20000}
```

如果长思考或复杂计算较慢、返回状态为 `running`，使用原 `run_id` 调用 `get_gemini_result` 继续等待：

```json
{"run_id":"RETURNED_RUN_ID","wait_ms":20000}
```

追问时继续调用 `ask_gemini_chat`，带上返回的 `chat_id`、新问题和新的 `request_id`。

**重试与去重规则：**

网络波动或调用中断需要重试时，**必须保持相同的 `request_id` 和完全一致的参数**，以避免触发模型重复生成；同一个 `request_id` 改参数会报 `IDEMPOTENCY_CONFLICT`。当正常聊天返回 `uncertain` 时，请按原 `run_id` 查询恢复，不要重新发一条新提问。

生成中或中断后，工具会通过 `partial.text` 提供已收到的最新正文，并标记 `partial.complete: false`。这份文字可能继续修改；完整结果使用 `completed` 状态和 `text` 字段。历史查询失败时，原请求与部分正文仍会返回，`recovery_error` 保留具体错误。`diagnostics` 记录传输错误、流完成状态、累计接收字符数和上游返回的模型标识，便于定位故障。

## 本地存储与隐私

会话凭据与 SQLite 状态默认保存在 `~/.local/share/ask-gemini-chat/`，与当前工作目录无关。可通过环境变量覆盖（需使用绝对路径）：

| 环境变量 | 作用 |
| --- | --- |
| `GEMINI_DATA_DIR` | 包含 `session.json` 和 `state.sqlite` 的数据目录 |
| `GEMINI_SESSION_FILE` | 会话文件路径 |
| `WEBCHAT_DATABASE` | SQLite 数据库文件路径 |
| `GEMINI_HTTP_PYTHON` | 安装了 HTTP 依赖的 Python 解释器路径 |

同一数据库同时只允许一个 MCP 服务端进程打开；第二个进程会收到 `DATABASE_LOCKED`。多客户端独立运行请配置不同的数据目录。登录凭据的并发更新由会话文件旁的私有 SQLite 锁串行化，请将会话目录放在本地文件系统。修改或删除本地数据文件前请先停止 MCP 服务。

安全提醒：你的提示词和上传的文件会发送给 Google；本地数据目录包含登录凭据与聊天记录原文。请勿在命令行参数中直接传入 Cookie、将凭据提交到代码库或在 Issue 中上传会话文件与数据库。

## 协议限制与验证状态

本项目基于 Gemini 的非官方私有网页协议实现，与 Google 无关，也不提供官方 API 回退或自动切模型。上游协议变更、风控策略或会话过期都可能影响可用性。

当前版本已通过 TypeScript 类型检查与本地测试，覆盖大文件磁盘上传、大响应帧、历史游标分页、幂等去重、多轮追问、进程恢复、跨进程锁与后台维护。真实 Argon（`95a4c0abcba24364`）的边界验证记录见 [BOUNDARIES.md](BOUNDARIES.md)；此前还验证了正常与临时聊天、README 写作、80 条长输出，以及 MCP 服务重启后的结果读取和同 ID 去重。

后台维护已通过一次 602 秒空闲后的真实 HTTP 验证。跨天保活和 Cookie 有效期延长仍待验证。

## 开源协议与贡献

本项目基于 MIT 协议开源，详见 [LICENSE](LICENSE) 与第三方依赖说明 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

欢迎提交 PR（请附带脱敏的合成复现用例与测试）。提交 Issue 或反馈问题前，请务必清理所有 Cookie、Token、账号标识、私有文件路径及聊天内容。
