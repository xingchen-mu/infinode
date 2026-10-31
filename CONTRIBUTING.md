# 参与贡献 / Contributing

欢迎提 Issue 和 Pull Request：bug、新的工作流模板、界面改进、文档都可以。

## 开发环境

需要 Node.js 22+ 和一个能访问的 ComfyUI。

```bash
npm install
npm run dev          # 前端 http://localhost:5173 + 后端 http://127.0.0.1:8787
npm run typecheck    # 提交前请确保没有类型错误
```

## 代码结构

```
src/                 前端（React + Zustand）
  canvas/            无限画布：渲染、拖拽、缩放、连线、工具栏
  editors/           局部重绘 / 扩图编辑器
  ui/                输入框、顶栏、模板库、工作流管理与映射编辑器
  lib/               API 封装、生成动作、几何计算
server/              后端（Hono）
  workflows/         内置工具的 ComfyUI 工作流、导入工作流的识别与运行
  tasks.ts           任务队列、进度跟踪（ComfyUI WebSocket）、结果下载
shared/types.ts      前后端共享的类型
presets/             官方模板转换来的预设（由脚本生成，不要手改）
scripts/             建 SSH 隧道、测试工作流、生成预设
```

## 新增官方模板预设

1. 在 `scripts/preset-sources.ts` 里加一项：模板名、中文名称、分类，需要的话设置开关值和要暴露的参数
2. 确保本机能连上一个装了官方模板包的 ComfyUI，并安装了 Google Chrome
3. 运行 `npm run build:presets -- <预设 id>`，检查 `presets/<id>.json` 的输入映射是否合理
4. 最好在真实的 ComfyUI 上跑一次

## 新增内置工具

内置工具的工作流在 `server/workflows/image.ts` / `video.ts`，模型文件名在 `server/workflows/models.ts`（写常见文件名 + 匹配规则，不同精度都能找到）。可以用下面的命令单独测试工作流：

```bash
npm run test:wf -- '{"op":"image.generate","model":"zimage","prompt":"a cat","aspect":"1:1","quality":"1k"}'
```

## 贡献授权

本项目采用"个人免费、商用授权"的模式（见 [LICENSE](LICENSE) 和 [COMMERCIAL.md](COMMERCIAL.md)）。提交 Pull Request 即表示你同意：

- 你的贡献是你本人的原创，或你有权提交它
- 你的贡献按本项目的许可证发布，并授予项目维护者永久、全球、免费、非独占的权利，可以把你的贡献包含在本项目的商业授权中一并授权给他人

如果不同意，请不要提交代码，可以通过 Issue 描述你的想法。

---

**English summary:** Issues and PRs are welcome. Run `npm run typecheck` before submitting. By submitting a pull request you confirm the contribution is yours to submit, and you agree that it is released under this project's license and may also be included in the commercial licenses the maintainers grant (a perpetual, worldwide, royalty-free, non-exclusive grant).
