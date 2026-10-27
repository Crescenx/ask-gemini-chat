# Gemini 登录助手（开发版）

插件在浏览器启动、两个 Gemini 登录 Cookie 变化时自动同步；正常时每 10 分钟检查一次，失败后每分钟重试。弹窗显示本地连接、Gemini 登录状态、最近检查时间，并可立即同步。

本地桥接复用现有 `SessionAuth` 的 HTTP 验证、账号绑定与跨进程锁。已有 MCP 自动读取更新，无需重启。插件不发送提问、不操作 Gemini 页面、不需要远程调试。

## 首次使用

1. 克隆仓库，在项目根目录运行 `npm run setup`。需要 Node 24+、Python 3.10+；Windows 或 WSL 连接 Windows Chrome 时需要 PowerShell 7（`pwsh.exe`）。
2. 在 `chrome://extensions` 开启开发者模式，加载仓库的 `extension/` 目录。无需复制插件 ID 或手动注册桥接。
3. 在插件所在的浏览器资料中登录 Gemini，使用默认 Google 账号（账号 0）。打开插件查看“已连接 / 已验证”。首次配置 MCP 客户端按 [INSTALL.md](../INSTALL.md) 完成；已有客户端无需重新配置。

setup 自动生成桥接并进行当前用户级注册：Windows 写 HKCU，Linux/macOS 写 Chrome 用户级 NativeMessagingHosts 目录，WSL 自动创建 Windows 侧启动脚本。不会申请管理员权限或改无关客户端配置。遇到另一份仓库占用同名桥接时明确报错，保留原注册，不擅自替换。

插件公钥固定，跨机器/路径的新安装 ID 一致。原来 `extension:prepare -- <ID>` 生成的旧 ID 会保留在允许列表；该命令仍作为仅生成文件的兼容入口保留，日常无需使用。其他账号使用单独浏览器资料及独立数据目录，不能删除原会话绕过账号检查。

## 老版本升级

第一次从不带自动升级的旧版迁移，在原仓库目录执行：

```sh
git pull --ff-only
npm run setup
```

已加载旧插件的用户，在 `chrome://extensions` 点一次“重新加载”。原来只装 MCP 的用户，加载一次 `extension/` 即可。无需卸载插件、重新登录或删除数据库。setup 保留已记录的 Python、代理、数据目录、会话位置，并迁移本项目的旧桥接注册。

从按路径生成 ID 的早期插件迁移到固定 ID 时，Chrome 会启用新条目，可能留下一个已停用的旧条目。确认新条目显示已连接后可移除停用的旧条目；本地聊天和会话不受影响。

以后用 `npm run update`：依次执行 `git pull --ff-only` 和 setup，更新依赖及注册；Git 冲突时停止，不自动 reset、stash 或覆盖修改。执行依赖更新前先让正在生成的请求完成。

只有源码变动时也可直接 `git pull --ff-only`。浏览器运行期间每分钟检查一次本地插件源码，连续两次一致后自动重载，通常约 1–2 分钟生效；无需访问 Google，也不依赖弹窗打开。依赖变动仍使用 `npm run update` 或 setup。插件升级增加权限时需要用户确认；修改 MCP stdio 入口或客户端环境时仍需重连 MCP。

保持仓库目录稳定；移动目录后重新运行 setup，并在 Chrome 更新加载路径。如果原位置仍被注册为另一份仓库，会要求先核对旧注册归属。不要提交或删除 `.runtime`、会话或数据库来“刷新”安装。

移除开发连接：禁用或移除插件，删除本项目对应的注册项/清单；保留 MCP 会话和数据库。

## 状态与恢复

| 状态 | 含义 |
| --- | --- |
| 已连接 + 已验证 | 桥接通过了真实 Gemini HTTP 验证；不代表完成 Argon 生成验证 |
| 未连接本地程序 | 注册或启动路径失效；自动重试，不要求重新登录 Google |
| 需要登录 | 浏览器缺少必要 Cookie 或 Google 拒绝当前会话；用户登录后自动同步 |
| 账号不一致 | 浏览器账号与本地绑定账号不同；保留原会话 |
| 网络错误 | 保留会话，自动重试 |

关闭 MCP 客户端后，只要浏览器仍运行，插件仍可启动桥接维护登录。浏览器完全退出或系统睡眠时不保证执行，再次启动/唤醒后恢复检查。后台挂起后通过 `chrome.alarms` 恢复，状态保存在 `storage.session`，不依赖弹窗常驻。

浏览器退出 Google 或移除 Cookie 时显示需要登录，但不删除本地会话或聊天数据。浏览器快照未变化时保留 HTTP 续期后的新 Cookie，避免旧快照覆盖新会话。

## 权限与数据

- `cookies` + `https://*.google.com/*`：读取并监听 Google 共享域的两个必要 Cookie，代码只挑选 `__Secure-1PSID` / `__Secure-1PSIDTS`，不采集其他 Cookie。
- `nativeMessaging`：经本机消息将 Cookie 交给仅允许该扩展连接的桥接，不开 HTTP 监听端口。
- `storage`：保存检查状态、时间及源码版本摘要，不保存 Cookie、账号标识或聊天。
- `alarms`：定时检查和失败重试，不发送保活问题。

Cookie 仅经本机消息传入原有私有会话文件，HTTP 验证只访问 Google；日志与插件状态不包含 Cookie。

协议依据：[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Cookies API](https://developer.chrome.com/docs/extensions/reference/api/cookies)、[Alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)。Native Messaging 使用原生字节序的 4 字节长度头；Chrome 对发往原生程序的单条消息有 64 MiB 上限，本实现用于桥接协议校验，与 Gemini 输入/附件能力无关。

## 本阶段验证

2026-10-27：Windows Chrome 155 → Native Messaging → WSL Ubuntu 26.04 / Node 24，完成真实登录同步、插件状态显示、桥接断线后约一分钟自动恢复，以及同步后的 Argon 完整回答验证。

升级验收：在已有安装上重复运行 setup，Python 和运行环境配置保持一致，旧 ID 仍能同步；首次重载后固定 ID 启用。随后仅修改磁盘版本，关闭插件弹窗，Chrome 自动从 0.1.0 重载为 0.2.0，无扩展错误。doctor 的三工具传输与登录检查通过，升级后 Argon 完整回答验证通过。`npm run check` 和 91 项回归通过，覆盖配置迁移、旧 ID 保留、注册幂等与冲突保护、自动重载和 WSL 启动参数。原生 Windows 后端、macOS 和长期休眠尚未实测。
