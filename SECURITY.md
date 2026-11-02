# 安全 / Security

## 报告漏洞

发现安全问题请不要公开提 Issue。请在仓库的 **Security** 页面点 **Report a vulnerability** 私下提交，只有维护者能看到。

## 使用须知

- Infinode 的后端**没有登录验证**，默认只监听本机 `127.0.0.1`。在 `.env` 里设置 `HOST=0.0.0.0` 后，同一网络里的任何人都能打开你的画布、删除作品、发起生成任务、修改它连接的 ComfyUI 地址。只在你信任的网络里这样做，不要暴露到公网。
- ComfyUI 本身也没有登录验证，同样不要直接暴露到公网。连接远程服务器建议用 SSH 隧道（见 README）。
- 所有接口都会检查请求的 Host：只接受 `localhost`、IP 地址（局域网共享时还有 `*.local`）和 `.env` 里 `ALLOWED_HOSTS` 列出的域名，其他网页即使通过 DNS 重绑定把自己的域名指向 127.0.0.1，也读不到也改不了你的画布。
- 画布助手（`/api/agent/*`）和 MCP 服务（`/mcp`）会花你的 API 额度和 GPU 时间，所以只接受运行服务的这台电脑发来、且地址是 `localhost` / `127.0.0.1` 的请求；局域网共享时别人用不了，网页也不能借 DNS 重绑定冒充本机调用。接入 MCP 的 agent 能做你在画布上能做的所有事，只接你信任的客户端。

## English

Please report vulnerabilities privately via the repository's **Security → Report a vulnerability** page, not in a public issue.

The Infinode backend has **no authentication** and binds to `127.0.0.1` by default. With `HOST=0.0.0.0`, anyone on your network can open your boards, delete your work, run generations and change the ComfyUI address. Only do that on networks you trust, never on the public internet. The same applies to ComfyUI itself.

Every request's Host header must be `localhost`, an IP address (or `*.local` when shared on the LAN) or a name in `ALLOWED_HOSTS`, so web pages that rebind their own domain to 127.0.0.1 cannot read or change your boards.

The canvas assistant (`/api/agent/*`) and the MCP endpoint (`/mcp`) spend your API credits and GPU time, so they only accept requests from this machine addressed to `localhost` / `127.0.0.1` (not from the LAN, and not from web pages that rebind their domain to 127.0.0.1). An agent connected over MCP can do anything you can do on the board: connect only clients you trust.
