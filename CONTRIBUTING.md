# 参与贡献 / Contributing

欢迎提 Issue 和 Pull Request：bug、新的工作流模板、界面改进、文档都可以。

## 开发环境

需要 Node.js 22.19+；实际生成还需要一个能访问的 ComfyUI。

```bash
npm install
npm run dev          # 前端 http://localhost:5173 + 后端 http://127.0.0.1:8787
npm run typecheck    # 提交前请确保没有类型错误
npm test             # 单元测试、假模型助手测试和 HTTP 接口回归（不需要 ComfyUI 和 API key）
npm run build && npm run smoke   # 和 CI 一样：构建，再检查后端在没有 ComfyUI 时能否正常启动
```

每个 Pull Request 都会自动运行 CI：在 Node 22 / 24 / 26 上做类型检查、构建和启动检查。CI 不连 ComfyUI，改了生成逻辑请自己在真实的 ComfyUI 上跑一遍，并在 PR 里写明。

## 代码结构

```
src/                 前端（React + Zustand）
  canvas/            渲染、拖拽、缩放、连线、节点操作和剪贴板
  projects/          画布切换、自动保存、跨页面同步和合并
  generation/        生成面板、模型选项、任务提交和图像编辑动作
  workflows/         模板库、工作流管理、映射编辑器和运行入口
  assistant/         画布助手界面
  assets/            素材导入、下载、截帧和预览
  editors/           局部重绘 / 扩图编辑器
  settings/          设置界面
  components/        通用弹窗、下拉框和 Markdown 渲染
  lib/api.ts         HTTP 客户端和 SSE 订阅
  store.ts           跨功能共享的画布状态、撤销重做和状态更新
  App.tsx            页面组装、全局事件和快捷键
  Modals.tsx         按状态选择功能弹窗
server/              后端（Hono）
  index.ts           启动服务、连接 ComfyUI、退出时刷盘
  app.ts             全局中间件、错误处理、路由和静态资源注册
  services.ts        创建并连接业务服务依赖
  routes/            按功能组织的 HTTP 接口和 SSE 事件流
  http/              Host 校验和本机访问判定
  projects/          画布存储、版本冲突和节点合并
  assets/            素材存储、索引和缩略图
  tasks/             任务队列、进度跟踪和结果下载
  comfy/             ComfyUI 客户端、能力检测和缓存
  workflows/         工作流构建、模型匹配、导入存储和官方预设
  agent/             助手运行时和画布工具
  mcp/               外部 agent 的 MCP 协议接入
shared/              前后端共享的类型、几何计算、许可证和翻译
presets/             官方模板转换来的预设（由脚本生成，不要手改）
scripts/             建 SSH 隧道、测试工作流、生成预设
test/                单元测试和使用临时数据目录的 HTTP 回归测试
```

功能代码放进对应目录；通用 UI 才放进 `components/`。前后端都需要的纯函数放进 `shared/`，后端不要引用 `src/`。`routes/` 处理 HTTP 输入输出，通过显式参数使用业务服务；业务模块不要导入 `app.ts` 或 `index.ts`。

本次目录划分只影响代码。画布仍保存到 `data/projects/<id>.json`，素材、任务、工作流等数据路径和 `DATA_DIR` 配置保持兼容，不需要迁移已有数据。

## 界面文字和翻译

界面上的文字直接写中文，用 `t()` 包起来：前端从 `src/i18n.ts` 引入，后端从 `server/i18n.ts` 引入，例如 `t('{n} 个节点', { n })`。然后在 `shared/locales/en.ts` 里加上英文，以中文原文为键；数量用 `{n}` 并写成 `['单数', '复数']`。只在定义处标记、到显示时才翻译的文字（比如存进数据里的标签）用 `msg()`。`npm test` 会检查界面里有没有漏掉的中文、词典里有没有缺的或多余的词条。画布助手的提示词和工具说明是写给模型看的，保持中文，不用翻译。

## 新增官方模板预设

1. 在 `scripts/preset-sources.ts` 里加一项：模板名、中文名称、分类，需要的话设置开关值和要暴露的参数；名称和说明的英文加进 `shared/locales/en.ts`
2. 确保本机能连上一个装了官方模板包的 ComfyUI，并安装了 Google Chrome
3. 运行 `npm run build:presets -- <预设 id>`，检查 `presets/<id>.json` 的输入映射是否合理
4. 最好在真实的 ComfyUI 上跑一次

## 新增内置工具

内置工具的工作流在 `server/workflows/image.ts` / `video.ts`，模型文件名在 `server/workflows/models.ts`（写常见文件名 + 匹配规则，不同精度都能找到）。可以用下面的命令单独测试工作流：

```bash
npm run test:wf -- '{"op":"image.generate","model":"zimage","prompt":"a cat","aspect":"1:1","quality":"1k"}'
```

## 贡献授权

本项目采用 [MIT 许可证](LICENSE)。提交 Pull Request 即表示你确认这份贡献是你本人的原创，或你有权提交它，并同意它按 MIT 许可证发布。

---

**English summary:** Issues and PRs are welcome. Interface text is written in Chinese inside `t()` with its English in `shared/locales/en.ts` (keyed by the Chinese); `npm test` fails on untranslated text. Run `npm run typecheck` and `npm test` before submitting; CI runs typecheck, build, the unit tests (including the canvas assistant on pi's faux model) and a startup smoke test (`npm run smoke`) on Node 22, 24 and 26 for every PR. By submitting a pull request you confirm the contribution is yours to submit and agree that it is released under the MIT License.
