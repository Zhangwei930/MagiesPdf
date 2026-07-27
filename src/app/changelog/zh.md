# 更新日志

## 1.0.2 — 2026-07-27

### 安全与可靠性

- 隔离 Electron 渲染与打印窗口，校验 IPC 调用来源，并限制隐藏窗口联网
- 为 REST API 增加输入限制、安全文件名、局域网 HTTPS、异步任务与取消能力
- 强化 PDF 动作清理与 OOXML ZIP 解压大小限制
- OCR 缺少语言模型时必须获得明确下载授权

### 功能与工程

- 新增本地 P12/PFX PDF 证书签名与签名字节完整性校验
- Office 导入导出优先使用已配置的外部转换器
- 工具总数增加到 58，并加入覆盖率门禁、CI 与依赖维护
- 未签名应用的更新下载和安装保持手动确认

### 首次打开（未签名安装包）

- **macOS**：执行 `xattr -dr com.apple.quarantine /Applications/MagiesPdf.app`，或右键 → 打开。Intel 用 `mac-x64`，Apple Silicon 用 `mac-arm64`
- **Windows**：SmartScreen → 更多信息 → 仍要运行
- **Linux AppImage**：先 `chmod +x` 再运行

## 1.0.1 — 2026-07-27

### 亮点

- **设置** 采用左侧导航分区（外观 / 文件 / 转换器 / API / 应用）
- **更新内容** 应用内弹框展示更新说明（不再跳转 GitHub 发布页）
- **默认开启自动更新**；双链源指向 `Zhangwei930/MagiesPdf`
- 去掉侧栏重复搜索栏（请用首页搜索或 ⌘K）
- 更新源不可用时的错误提示更简洁

### 首次打开（未签名安装包）

- **macOS**：执行 `xattr -dr com.apple.quarantine /Applications/MagiesPdf.app`，或右键 → 打开。Intel 用 `mac-x64`，Apple Silicon 用 `mac-arm64`
- **Windows**：SmartScreen → 更多信息 → 仍要运行
- **Linux AppImage**：先 `chmod +x` 再运行

## 1.0.0 — 2026-07-27

**MagiesPdf** 首个公开开源版本。

### 亮点

- **57 个本地 PDF 工具**（整理、转换、安全、编辑、高级）
- **抽屉侧栏** — 点击分类展开工具
- **流水线** — 内置预设，支持保存/加载与 JSON 导入导出
- **批量处理** — 支持递归选择文件夹
- **本地 REST API**（默认关闭，需 Bearer 令牌）
- **可见签名**（手绘 / 图片 / 文字）— 非证书数字签名
- **品牌图标** 覆盖 macOS / Windows / Linux 安装包

### 本版本明确不做

- 不做 PDF **证书**（PKCS#7 / X.509）签名或校验
- 不做安装包 **代码签名 / 公证**（开源分发）

### 首次打开（未签名安装包）

- **macOS**：安装后执行 `xattr -dr com.apple.quarantine /Applications/MagiesPdf.app`，或右键 → 打开
- **Windows**：SmartScreen → 更多信息 → 仍要运行
- **Linux AppImage**：`chmod +x` 后运行

### 平台（与 MagiesTerminal 一致）

- **macOS**：DMG + ZIP · arm64、x64（Intel）
- **Windows**：NSIS + portable + ZIP · x64、arm64
- **Linux**：AppImage、deb、rpm、pacman · x64、arm64

### 升级（双链）

- 设置 → 检查更新（仅安装包）
- 大陆优先 `dl.magies.top/magiespdf/stable`，海外优先 GitHub `Zhangwei930/MagiesPdf`
- 任一源失败自动切换另一源
