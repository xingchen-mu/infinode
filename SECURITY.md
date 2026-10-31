# 安全 / Security

## 报告漏洞

发现安全问题请不要公开提 Issue。请在仓库的 **Security** 页面点 **Report a vulnerability** 私下提交，只有维护者能看到。

## 使用须知

- Comfy Canva 的后端**没有登录验证**，默认只监听本机 `127.0.0.1`。在 `.env` 里设置 `HOST=0.0.0.0` 后，同一网络里的任何人都能打开你的画布、删除作品、发起生成任务、修改它连接的 ComfyUI 地址。只在你信任的网络里这样做，不要暴露到公网。
- ComfyUI 本身也没有登录验证，同样不要直接暴露到公网。连接远程服务器建议用 SSH 隧道（见 README）。

## English

Please report vulnerabilities privately via the repository's **Security → Report a vulnerability** page, not in a public issue.

The Comfy Canva backend has **no authentication** and binds to `127.0.0.1` by default. With `HOST=0.0.0.0`, anyone on your network can open your boards, delete your work, run generations and change the ComfyUI address. Only do that on networks you trust, never on the public internet. The same applies to ComfyUI itself.
