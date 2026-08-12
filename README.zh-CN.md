# Magies Office

[English](./README.md) · **简体中文**

**本地优先的桌面办公套件：Word、Excel、PowerPoint 与 PDF 同窗处理。**

合并、转换、加密、编辑与自动化 —— **全部在你自己的电脑上完成**。
不上传云端、不需要账号、无遥测。

<p align="center">
  <a href="https://github.com/Zhangwei930/MagiesPdf/releases/latest"><img alt="下载" src="https://img.shields.io/github/v/release/Zhangwei930/MagiesPdf?label=Download&style=flat-square" /></a>
  <a href="https://github.com/Zhangwei930/MagiesPdf/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Zhangwei930/MagiesPdf/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="./LICENSE"><img alt="许可证" src="https://img.shields.io/badge/License-AGPL--3.0--or--later-green?style=flat-square" /></a>
  <a href="https://pdf.magies.top"><img alt="官网" src="https://img.shields.io/badge/Website-pdf.magies.top-blue?style=flat-square" /></a>
</p>

产品名称为 **Magies Office**。源码仓库仍为
[Zhangwei930/MagiesPdf](https://github.com/Zhangwei930/MagiesPdf)；
安装包文件名继续使用 `MagiesPdf-…` 前缀，以保持连续性。

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| macOS | Intel + Apple Silicon | DMG + zip |
| Windows | x64 + ARM64 | NSIS、便携版、zip |
| Linux | x64 | AppImage + deb |

每个安装包都内置对应的 **LibreOffice** 运行时（预览与格式转换），
以及内嵌的 **ONLYOFFICE Document Server 9.4** 编辑器。无需再单独安装 Office。
**Linux ARM64** 暂无预编译包，见 [Linux ARM64](#linux-arm64-支持)。

**最新版本** — [更新日志](./CHANGELOG.md) ·
[Releases](https://github.com/Zhangwei930/MagiesPdf/releases/latest) ·
[贡献指南](./CONTRIBUTING.md) · [安全政策](./SECURITY.md) ·
官网：<https://pdf.magies.top>

安装包为**未签名**开源构建（首次打开时系统可能提示未验证开发者）。
PDF 证书签名仅在本地处理：P12/PFX 材料不会离开本机，也不会被 Magies Office 保存。

---

## 截图

| 起始页 — 新建文档与常用转换 | 设置 — 本地 / 隐私模型 |
| :------------------------: | :--------------------: |
| ![Magies Office 起始页：新建文档类型与常用转换](docs/screenshots/home-start-centre.jpg) | ![设置：AI 与 MCP — Ollama、LM Studio 与 OpenAI 兼容服务商](docs/screenshots/settings-ai-mcp.jpg) |

<p align="center">
  <img src="docs/screenshots/office-editor-tabs.jpg" alt="内嵌 Word 编辑器，标签页含 docx、xlsx、pptx 与 pdf" width="920" />
  <br />
  <em>Word / Excel / PowerPoint / PDF 同窗标签页</em>
</p>

| 用 AI 改演示文稿 | 根据表格数据起草报告 |
| :--------------: | :------------------: |
| ![在 Magies Office 中用 AI 编辑 PowerPoint](docs/screenshots/ai-assistant-pptx.jpg) | ![AI 根据 Excel 数据起草 Word 季度报告](docs/screenshots/ai-assistant-docx.jpg) |

---

## 能做什么

### 一个窗口处理所有文档

| 模式 | 说明 |
| --- | --- |
| **PDF 工作区** | 以标签页打开 PDF；连续滚动、搜索、脱敏、盖章、填表，运行全部 **61 个工具**，完整撤销 |
| **Office 编辑器** | 在 **Magies Office 内以标签页** 新建/打开 Word、Excel、PowerPoint（及 ODF）—— 内嵌 ONLYOFFICE 走本机回环，无需架服务器、无需账号 |
| **AI 自动化** | 对你授权的文件夹做自然语言任务；交互式确认，或「审核队列 / 无人值守」规则 |

PDF 工具以**右侧任务窗格或紧凑对话框**打开，设置选项时页面始终可见。
Office 编辑与 PDF 共用同一套工具栏和标签页。

LibreOffice 仍随包提供，负责 **PDF 预览与高保真格式转换**。
内嵌引擎承担的是*编辑*路径。

### AI 安全（简版）

- 交互式对话：每次工具调用都需你确认
- 文件夹规则：**审核**（排队等你点）或 **无人值守**（仅限你勾选的本地 Office 工具）
- 文档宏始终需要交互确认，**绝不会**在无人值守规则中运行
- 写操作一律生成新副本，不覆盖源文件
- 模型只收到你的提示词、工具摘要，以及你批准的有限纯文本预览 —— 不会整份上传文档字节

在 **设置 → AI** 中配置模型（OpenAI、DeepSeek、通义、Ollama 等）。

---

## 首次启动（未签名构建）

> **macOS：** 未代码签名、未公证。拖入「应用程序」后执行：
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Magies Office.app"
> ```
>
> 或右键 → **打开** → 确认。Intel 选 **`mac-x64`**，
> Apple Silicon 选 **`mac-arm64`**。

> **Windows：** SmartScreen 可能提示「Windows 已保护你的电脑」。选择
> **更多信息** → **仍要运行**。优先使用 `MagiesPdf-*-win-x64.exe`
> （ARM / Snapdragon 机器用 arm64）。桌面快捷方式名称为 **Magies Office**。

> **Linux（AppImage）：**
>
> ```bash
> chmod +x MagiesPdf-*-linux-*.AppImage
> ./MagiesPdf-*-linux-*.AppImage
> ```
>
> `.deb` 按系统包管理器正常安装即可。

### 打开后 — 一分钟自检

1. 首页显示 **内置 Office 引擎已就绪**（绿色）。若没有，请重新安装。
2. **PDF：** 新建 PDF 或拖入文件 → 在阅读器中编辑 → `⌘S` / `Ctrl+S`。
3. **Office：** 新建文档 / 表格 / 演示文稿 → 在本窗口以标签页打开。
4. **AI（可选）：** 设置 → AI → 填写 Base URL 与模型 → 在 AI 面板授权办公目录 → 确认第一次工具调用。

---

## 为什么坚持本地

多数在线 PDF / 办公工具会先要求你上传文件。合同、工资条、护照扫描件
并不适合这样处理。Magies Office 把同样的工作放在你的电脑上完成，文件不会离开本机。

网络访问仅限：

- 可选的**双链路**更新检查（海外走 GitHub Releases；
  中国大陆走 `dl.magies.top/magiespdf/stable`，并互为回退）
- 经你确认的 OCR 语言模型下载
- 你自行配置的 AI 服务调用（仅提示词 + 已批准的预览）

未签名的更新包在单独确认之前，不会自动下载或安装。

---

## PDF 工具（61）

### 整理
| 工具 | 作用 |
| --- | --- |
| 合并 PDF | 按任意顺序合并文件 |
| 拆分 PDF | 按页数、切点、等份或文件大小 |
| 提取 / 删除页面 | 用完整页码语法保留或丢弃页面 |
| 重排 | 自定义顺序、倒序、奇偶页、双面修复、小册子 |
| 旋转 | 90° / 180° / 270° |
| 按章节拆分 | 按大纲 / 标题变化切开 |
| 删除空白页 | 去掉空页 |
| 裁剪 / 缩放 | 几何调整 |
| N 合 1 / 单页拆分 | 拼版或拆成单页 |
| 叠加 PDF | 把一份 PDF 盖到另一份上 |

### 转换
| 工具 | 作用 |
| --- | --- |
| PDF ↔ 图片 | 渲染页面；从 PNG/JPG 生成 PDF |
| PDF → 文本 / Markdown / HTML / CSV | 提取结构化文本 |
| PDF → Word / Excel / PowerPoint | 可编辑导出；可选外部高保真路径 |
| Markdown / HTML / 文本 / CSV → PDF | Chromium `printToPDF` 排版 |
| Word / Excel / PowerPoint → PDF | 内置 LibreOffice 路径 + 可选外部转换器 |

### 安全
| 工具 | 作用 |
| --- | --- |
| 添加 / 移除密码 | AES-256 等相关加密 |
| 水印 | 半透明文字，支持中日韩 |
| 添加签名 | 手写 / 图片 / 打字可见签章 |
| 证书数字签名 | 本地 P12/PFX PKCS#7 签名 |
| 检查签名 | 已签名字节完整性与证书详情 |
| 脱敏 | 关键词永久涂黑 |
| 净化 / 扁平化 | 剥离风险对象；固化表单取值 |
| 元数据 | 编辑或清除 |
| 显示 JavaScript | 展示嵌入脚本 |

### 编辑
| 工具 | 作用 |
| --- | --- |
| 新建空白 PDF | 多页空白文档 |
| 添加 / 替换文字 | 插入文字或原位替换 |
| 压缩 / 修复 / OCR | 体积、修复、识别文字（强力压缩会重新编码图片） |
| 灰度 | 将选定页栅格化为灰度 |
| 页码 / 页眉页脚 | 编号与栏目标题 |
| 图章 | 图片印章与 Logo |
| 附件 / 书签 | 嵌入文件；重建大纲 |
| 创建 / 填写表单 | 表单域与取值 |
| 比较 / 信息 | 文本 diff；查看文档信息 |

### 高级
| 工具 | 作用 |
| --- | --- |
| 流水线 | 可视化串联工具，支持预设与 JSON 导入导出 |
| 批量 | 对多文件运行同一工具；可递归添加整个文件夹 |

凡是读取 PDF 的工具都支持加密源文件，并提供密码参数。

### 页码选择语法

```
1,3,5       指定页，按书写顺序
2-8         区间
8-2         反向区间
8-    -3    开放端点
N           最后一页（也可写在区间内：8-N）
1-10/3      区间内每隔 3 页
all  odd  even  first  last
```

---

## 本机 REST API 与 MCP

默认关闭。在 **设置 → 本机 REST API** 中启用并设置 Bearer Token 后：

```bash
# 健康检查（无需鉴权）
curl http://127.0.0.1:8737/v1/health

# 列出工具
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8737/v1/tools

# 运行工具
curl -X POST http://127.0.0.1:8737/v1/tools/organize.rotate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"name":"a.pdf","bytesBase64":"..."}],"params":{"degrees":"90"}}'
```

默认只绑定本机回环；局域网绑定需显式开启。
局域网模式要求提供 PEM 证书与私钥的绝对路径，且仅提供 HTTPS。
工具 POST 加 `?async=true` 可拿到任务 ID；用 `GET /v1/jobs/<id>` 轮询，
或用 `DELETE /v1/jobs/<id>` 取消。

启用本机 API 后，还可在 **设置 → MCP** 中把工具暴露给外部智能体
（stdio 配置适用于 Codex、Claude Code 等）。你接入的外部 MCP 服务，
每次工具调用仍需确认。

---

## 安装包产物

| 系统 | 产物 | 构建命令 |
| --- | --- | --- |
| macOS | Intel / Apple Silicon 的 DMG 与 zip | `npm run pack:mac-x64` / `pack:mac-arm64` |
| Windows | x64 / ARM64 的 NSIS、便携 exe 与 zip | `npm run pack:win-x64` / `pack:win-arm64` |
| Linux | x64 的 AppImage 与 deb | `npm run pack:linux-x64` |

```bash
npm run pack:mac-x64    # Intel (x86_64)
npm run pack:win-x64
npm run pack:linux-x64
# 发布 CI 会在各平台原生 runner 上构建全部受支持目标。
```

---

## Linux ARM64 支持

预编译安装包覆盖：Linux x86_64、Windows（x64 + ARM64）、macOS（Intel + Apple Silicon）。

**Linux ARM64**（如树莓派 4/5、Asahi Linux、ARM 云主机）请用发行版自带的 LibreOffice 从源码运行：

```bash
sudo apt update && sudo apt install -y libreoffice
git clone https://github.com/Zhangwei930/MagiesPdf.git
cd MagiesPdf
npm install
npm run prepare:engine -- --shared
npm run prepare:engine -- --platform=linux --arch=arm64
npm run dev
```

如有需要，在应用内 **设置 → Office** 指定 LibreOffice 路径
（通常为 `/usr/bin/soffice`）。

---

## 开发

需要 **Node.js 22+**。

```bash
npm install
npm run prepare:engine -- --shared                 # 首次：共享编辑器与字体
npm run prepare:engine -- --platform=darwin --arch=arm64   # 或 darwin/x64、win32/*、linux/x64
npm run dev          # worker 打包 + Vite + Electron
npm run verify       # lint + typecheck + 测试 + 构建 + 包边界检查
npm run test:coverage
```

```bash
npm test
node --test --import tsx src/core/pageRange.test.ts
npm run pack:mac-x64 / pack:win-x64 / pack:linux-x64
```

### 二进制下载失败时

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm install
```

### 架构

```
electron/     主进程 — 窗口、IPC、worker 池、host、API、更新器、
              LibreOffice、内嵌 ONLYOFFICE 宿主、AI 智能体、MCP
src/core/     同构 PDF 引擎 — 无 DOM、无 Electron、无 React
src/node/     worker + 主进程工具入口
src/app/      React 渲染层 — 仅接收工具目录元数据；禁止导入 mupdf/pdf-lib
```

**一个工具 = 一份描述符。** 卡片网格、选项表单、⌘K、流水线面板与 REST 路由
都从它派生。

**渲染进程不能执行工具。** 它通过 IPC 接收目录*数据*，因此 MuPDF WASM
不会进入 UI 包。

**两套 PDF 引擎。** MuPDF 负责解密/加密/渲染/文本；pdf-lib 负责组合与绘制。
保存缓冲区始终从 WASM 堆中拷贝出来。

**Office。** 编辑使用本机回环上的内嵌 ONLYOFFICE Document Server 构建；
LibreOffice 继续负责 PDF 预览与转换。若引擎不完整，打包会直接失败，
而不是产出一个打不开文档的应用。

**AI。** OpenAI 兼容客户端 + 白名单内的 PDF / Office 工具；文件夹规则支持
审核与无人值守两种模式，并硬性禁止无人值守运行宏。

分层规则与 MuPDF 注意事项见 [`Claude.md`](./Claude.md)。

---

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题请按 [SECURITY.md](./SECURITY.md)
私下报告，不要公开提可利用的漏洞。

## 许可证

**AGPL-3.0-or-later。**

基于 [MuPDF](https://mupdf.com/)（AGPL-3.0）、
[pdf-lib](https://pdf-lib.js.org/)（MIT）、
[PDF.js](https://mozilla.github.io/pdf.js/)（Apache-2.0）、
[ONLYOFFICE Document Server](https://github.com/ONLYOFFICE/DocumentServer)
（AGPL-3.0）以及捆绑的 [LibreOffice](https://www.libreoffice.org/) 运行时。

第三方声明与再分发说明：[`NOTICE.md`](./NOTICE.md)。
