import type { LocalizedText } from '@core/types.ts';

export type Locale = 'zh' | 'en';

/** UI chrome strings. Tool names and params carry their own bilingual text. */
const UI = {
  appName: { zh: 'MagiesPdf', en: 'MagiesPdf' },
  tagline: {
    zh: '全部处理都在这台电脑上完成，文件不会离开本机。',
    en: 'Everything runs on this machine. Your files never leave it.',
  },
  search: { zh: '搜索工具…', en: 'Search tools…' },
  searchHint: { zh: '按 ⌘K 快速搜索', en: 'Press ⌘K to search' },
  noResults: { zh: '没有匹配的工具', en: 'No matching tools' },
  home: { zh: '首页', en: 'Home' },
  back: { zh: '返回', en: 'Back' },
  settings: { zh: '设置', en: 'Settings' },
  recent: { zh: '最近使用', en: 'Recently used' },
  allTools: { zh: '全部工具', en: 'All tools' },
  filterTools: { zh: '筛选工具…', en: 'Filter tools…' },
  expandFolder: { zh: '点击展开', en: 'Click to expand' },
  collapseFolder: { zh: '点击收起', en: 'Click to collapse' },
  sidebarHint: {
    zh: '左侧点分类即可展开工具列表；首页或 ⌘K 搜索工具。',
    en: 'Click a category on the left to expand its tools — or search from Home / ⌘K.',
  },

  openPreview: { zh: '打开 PDF 预览', en: 'Open & Preview PDF' },
  openPreviewHint: { zh: '像阅读器一样先看内容，再决定用什么工具', en: 'View the pages first, then decide what to do with them' },
  previewPdf: { zh: '预览', en: 'Preview' },
  viewerLoading: { zh: '正在加载 PDF…', en: 'Loading PDF…' },
  viewerLoadFailed: { zh: '无法打开该 PDF', en: 'Could not open this PDF' },
  viewerPageOf: { zh: '第 {page} / {count} 页', en: 'Page {page} of {count}' },
  viewerChooseTool: { zh: '选择工具', en: 'Choose a tool' },
  viewerZoomIn: { zh: '放大', en: 'Zoom in' },
  viewerZoomOut: { zh: '缩小', en: 'Zoom out' },
  viewerFitWidth: { zh: '适合宽度', en: 'Fit width' },
  viewerFitPage: { zh: '适合整页', en: 'Fit page' },
  viewerActualSize: { zh: '实际大小', en: 'Actual size' },
  viewerGoToPage: { zh: '跳转到页码', en: 'Go to page' },
  viewerPanHint: {
    zh: '按住空格并拖动可平移页面；按住 ⌘ 滚动可缩放。',
    en: 'Hold Space and drag to pan; hold ⌘ and scroll to zoom.',
  },
  viewerPrevPage: { zh: '上一页', en: 'Previous page' },
  viewerNextPage: { zh: '下一页', en: 'Next page' },
  viewerRotatePage: { zh: '旋转此页 90°', en: 'Rotate this page 90°' },
  viewerDeletePage: { zh: '删除此页', en: 'Delete this page' },
  viewerDragHint: { zh: '拖动缩略图可调整页面顺序', en: 'Drag a thumbnail to reorder pages' },
  viewerEdited: { zh: '已修改', en: 'Edited' },
  viewerUndo: { zh: '撤销', en: 'Undo' },
  viewerSave: { zh: '保存为…', en: 'Save as…' },
  viewerApplying: { zh: '正在应用…', en: 'Applying…' },
  viewerEditFailed: { zh: '操作失败', en: 'That operation failed' },
  viewerLastPage: { zh: '不能删除最后一页', en: 'Cannot delete the only page' },
  viewerLocked: { zh: '这个 PDF 已加密', en: 'This PDF is encrypted' },
  viewerLockedHint: {
    zh: '输入打开密码即可预览和编辑。密码只留在本机内存里。',
    en: 'Enter the open password to preview and edit it. The password stays in memory on this machine.',
  },
  viewerPasswordLabel: { zh: '文档密码', en: 'Document password' },
  viewerPasswordWrong: { zh: '密码不对，请重试', en: 'That password was rejected — try again' },
  viewerUnlock: { zh: '解锁', en: 'Unlock' },
  viewerDiscardTitle: { zh: '放弃未保存的修改？', en: 'Discard unsaved changes?' },
  viewerDiscardHint: {
    zh: '这个 PDF 有还没保存的修改，离开就会丢失。',
    en: 'This PDF has edits you have not saved yet. Leaving will lose them.',
  },
  viewerDiscardLeave: { zh: '放弃并离开', en: 'Discard and leave' },
  viewerDiscardStay: { zh: '留下继续编辑', en: 'Stay here' },
  viewerRedactMode: { zh: '框选涂黑', en: 'Redact a box' },
  viewerRedactHint: {
    zh: '在页面上拖出一块区域，松手即永久删除其中内容（不可恢复，可撤销一步）。',
    en: 'Drag a box over the page. On release its contents are permanently removed — irreversible in the file, but one undo step is kept.',
  },
  viewerRedactExit: { zh: '退出框选', en: 'Done redacting' },
  viewerStampMode: { zh: '盖章', en: 'Stamp' },
  viewerStampExit: { zh: '退出盖章', en: 'Done stamping' },
  viewerStampHint: {
    zh: '点击页面上任意位置盖章，图章以点击处为中心。可连续盖多处。',
    en: 'Click anywhere on the page to stamp; the image centres on the click. Stamp as many spots as you like.',
  },
  viewerStampPick: { zh: '选择图章图片（PNG/JPG）', en: 'Choose a stamp image (PNG/JPG)' },
  viewerFormMode: { zh: '填表单', en: 'Fill form' },
  viewerFormExit: { zh: '退出填写', en: 'Done filling' },
  viewerFormHint: {
    zh: '直接在页面上的输入框里填写，改完点「应用填写」写入文档。',
    en: 'Type straight into the boxes on the page, then click Apply to write them into the document.',
  },
  viewerFormApply: { zh: '应用填写', en: 'Apply' },
  viewerFormNone: {
    zh: '这一页没有可填写的表单域。',
    en: 'This page has no fillable form fields.',
  },
  viewerFormSkipped: {
    zh: '有 {count} 个字段名含特殊字符（= 或换行），无法安全填写，已跳过。',
    en: '{count} field(s) have names containing "=" or a line break and were skipped as unsafe to fill.',
  },
  viewerDecryptNotice: {
    zh: '注意：在这里编辑后保存的副本不再带密码。要保留加密请用「添加密码」工具重新加密。',
    en: 'Note: a copy saved after editing here is no longer password-protected. Re-encrypt it with the Add Password tool if you need that.',
  },

  chooseFiles: { zh: '选择文件', en: 'Choose files' },
  chooseFile: { zh: '选择文件', en: 'Choose a file' },
  dropHere: { zh: '把文件拖到这里，或点击选择', en: 'Drop files here, or click to choose' },
  dropHereNow: { zh: '松手即可添加', en: 'Release to add' },
  accepts: { zh: '支持格式', en: 'Accepts' },
  fileCount: { zh: '个文件', en: 'files' },
  removeFile: { zh: '移除', en: 'Remove' },
  clearFiles: { zh: '清空', en: 'Clear all' },
  moveUp: { zh: '上移', en: 'Move up' },
  moveDown: { zh: '下移', en: 'Move down' },
  needMoreFiles: { zh: '至少还需要', en: 'Needs at least' },
  more: { zh: '个文件', en: 'more file(s)' },

  options: { zh: '选项', en: 'Options' },
  advancedOptions: { zh: '高级选项', en: 'Advanced options' },
  pipelineSteps: { zh: '流水线步骤', en: 'Pipeline steps' },
  pipelineAddStep: { zh: '添加步骤', en: 'Add step' },
  pipelineNoParams: { zh: '此工具没有可配置参数。', en: 'This tool has no configurable options.' },
  pipelineStepCount: { zh: '个步骤', en: 'step(s)' },
  batchTargetTool: { zh: '要对每个文件执行的工具', en: 'Tool to run on each file' },
  signSource: { zh: '签名来源', en: 'Signature source' },
  signDraw: { zh: '手绘', en: 'Draw' },
  signImage: { zh: '图片', en: 'Image' },
  signText: { zh: '文字', en: 'Typed' },
  signDrawPad: { zh: '在下方书写签名', en: 'Draw your signature below' },
  signDrawHint: {
    zh: '用鼠标或触控笔书写。导出为透明感的白底签名图盖到 PDF 上。',
    en: 'Use a mouse or stylus. Exported as a clean signature image onto the PDF.',
  },
  signClear: { zh: '清除', en: 'Clear' },
  pipelinePresets: { zh: '已保存的流水线', en: 'Saved pipelines' },
  pipelineBuiltinPresets: { zh: '内置预设', en: 'Built-in presets' },
  pipelineSavePreset: { zh: '保存当前', en: 'Save current' },
  pipelineLoadPreset: { zh: '加载', en: 'Load' },
  pipelineDeletePreset: { zh: '删除', en: 'Delete' },
  pipelinePresetName: { zh: '预设名称', en: 'Preset name' },
  pipelinePresetEmpty: { zh: '还没有自己保存的流水线', en: 'No personal saved pipelines yet' },
  pipelinePresetSaved: { zh: '已保存', en: 'Saved' },
  pipelineExport: { zh: '导出 JSON', en: 'Export JSON' },
  pipelineImport: { zh: '导入 JSON', en: 'Import JSON' },
  pipelineImportOk: { zh: '已导入预设', en: 'Preset imported' },
  pipelineImportBad: { zh: '无法识别该预设文件', en: 'Could not read that preset file' },
  batchAddFolder: { zh: '添加文件夹…', en: 'Add folder…' },
  batchRecursive: { zh: '包含子文件夹', en: 'Include subfolders' },
  batchFolderTruncated: {
    zh: '已达到 200 个文件上限，未加载更多。',
    en: 'Stopped at 200 files — more may exist on disk.',
  },
  batchFolderLoaded: { zh: '已从文件夹加入', en: 'Added from folder' },
  run: { zh: '开始处理', en: 'Run' },
  running: { zh: '处理中…', en: 'Working…' },
  cancel: { zh: '取消', en: 'Cancel' },
  reset: { zh: '重置选项', en: 'Reset options' },

  results: { zh: '处理结果', en: 'Results' },
  saveAll: { zh: '全部保存', en: 'Save all' },
  saveAs: { zh: '另存为', en: 'Save as' },
  savedTo: { zh: '已保存到', en: 'Saved to' },
  reveal: { zh: '在文件夹中显示', en: 'Show in folder' },
  jobs: { zh: '任务', en: 'Jobs' },
  noJobs: { zh: '还没有任务', en: 'No jobs yet' },
  clearFinished: { zh: '清除已完成', en: 'Clear finished' },
  retry: { zh: '重试', en: 'Retry' },
  succeeded: { zh: '已完成', en: 'Done' },
  failed: { zh: '失败', en: 'Failed' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  queued: { zh: '排队中', en: 'Queued' },

  theme: { zh: '主题', en: 'Theme' },
  themeSystem: { zh: '跟随系统', en: 'System' },
  themeLight: { zh: '浅色', en: 'Light' },
  themeDark: { zh: '深色', en: 'Dark' },
  language: { zh: '语言', en: 'Language' },
  outputDirectory: { zh: '默认输出目录', en: 'Default output folder' },
  outputDirectoryHelp: {
    zh: '留空则每次都询问保存位置。',
    en: 'Leave empty to be asked each time.',
  },
  browse: { zh: '浏览…', en: 'Browse…' },
  clear: { zh: '清除', en: 'Clear' },
  onCollision: { zh: '同名文件', en: 'When a name is taken' },
  collisionRename: { zh: '自动改名（推荐）', en: 'Rename automatically (recommended)' },
  collisionOverwrite: { zh: '直接覆盖', en: 'Overwrite' },

  externalConverter: { zh: '外部文档转换器', en: 'External document converter' },
  externalConverterHelp: {
    zh: '可选。配置后，Office 类转换会优先走此命令行工具以获得更高版式保真度。不配置则使用内置转换。MagiesPdf 不捆绑、不依赖任何具体第三方软件。',
    en: 'Optional. When set, Office conversions prefer this command-line tool for higher layout fidelity; otherwise the built-in converter is used. MagiesPdf ships and names no third-party converter.',
  },
  externalConverterExecutable: { zh: '可执行文件路径', en: 'Executable path' },
  externalConverterArgs: { zh: '参数模板', en: 'Argument template' },
  externalConverterArgsHelp: {
    zh: '用空格分隔参数。{in} 替换为输入文件路径，{out} 替换为输出目录。',
    en: 'Space-separated arguments. {in} becomes the input path, {out} the output directory.',
  },
  externalConverterTimeout: { zh: '超时', en: 'Timeout' },
  externalConverterNotConfigured: {
    zh: '未配置（当前使用内置转换器）',
    en: 'Not configured (using built-in converter)',
  },
  externalConverterConfigured: {
    zh: '已配置',
    en: 'Configured',
  },

  apiSection: { zh: '本地 REST API', en: 'Local REST API' },
  apiSectionHelp: {
    zh: '默认关闭。开启后可在本机用 HTTP 调用全部工具（需 Bearer 令牌）。',
    en: 'Off by default. When on, every tool is reachable over HTTP on this machine (Bearer token required).',
  },
  apiEnabled: { zh: '启用 API', en: 'Enable API' },
  apiPort: { zh: '端口', en: 'Port' },
  apiToken: { zh: '访问令牌', en: 'Access token' },
  apiTokenHelp: {
    zh: '请求头：Authorization: Bearer <令牌>。请妥善保管，拥有令牌等同于能读写本机文件。',
    en: 'Send Authorization: Bearer <token>. Treat it like a password — it can run tools on your files.',
  },
  apiGenerateToken: { zh: '生成令牌', en: 'Generate token' },
  apiAllowLan: { zh: '允许局域网访问', en: 'Allow LAN access' },
  apiAllowLanHelp: {
    zh: '默认只监听 127.0.0.1。局域网访问仅支持 HTTPS，并需要填写 PEM 证书和私钥的绝对路径。',
    en: 'Loopback only by default. LAN access is HTTPS-only and requires absolute paths to a PEM certificate and private key.',
  },
  apiTlsCert: { zh: 'TLS 证书路径', en: 'TLS certificate path' },
  apiTlsKey: { zh: 'TLS 私钥路径', en: 'TLS private-key path' },
  apiStatusRunning: { zh: '运行中', en: 'Running' },
  apiStatusStopped: { zh: '未运行', en: 'Stopped' },
  apiEndpoint: { zh: '地址', en: 'Endpoint' },

  settingsNavAppearance: { zh: '外观', en: 'Appearance' },
  settingsNavFiles: { zh: '文件', en: 'Files' },
  settingsNavConverter: { zh: '转换器', en: 'Converter' },
  settingsNavApi: { zh: 'API', en: 'API' },
  settingsNavApp: { zh: '应用', en: 'Application' },

  updatesSection: { zh: '软件更新', en: 'Updates' },
  updatesHelp: {
    zh: '双链更新：GitHub Releases（Zhangwei930/MagiesPdf）与国内镜像互为备份。开源构建不签名。',
    en: 'Dual-link updates: GitHub Releases (Zhangwei930/MagiesPdf) with a mainland mirror as fallback. Open-source builds are unsigned.',
  },
  updatesAuto: { zh: '自动检查并下载更新', en: 'Automatically check and download updates' },
  updatesAutoHelp: {
    zh: '默认开启。启动后自动检查并后台下载；安装前需点击「重启安装」确认（开源构建未签名）。',
    en: 'On by default. Checks after launch and downloads in the background. You still click Restart to install (unsigned open-source builds).',
  },
  updatesCurrentVersion: { zh: '当前版本', en: 'Current version' },
  updatesCheck: { zh: '检查更新', en: 'Check for updates' },
  updatesDownload: { zh: '下载更新', en: 'Download update' },
  updatesInstall: { zh: '重启安装', en: 'Restart to install' },
  updatesIdle: { zh: '尚未检查', en: 'Not checked yet' },
  updatesChecking: { zh: '正在检查…', en: 'Checking…' },
  updatesCurrent: { zh: '已是最新版本', en: 'You are up to date' },
  updatesAvailable: { zh: '发现新版本', en: 'Update available' },
  updatesDownloading: { zh: '正在下载…', en: 'Downloading…' },
  updatesReady: { zh: '已下载，可安装', en: 'Downloaded — ready to install' },
  updatesError: { zh: '更新失败', en: 'Update failed' },
  updatesDevNote: {
    zh: '当前为开发运行，更新通道仅在安装包中可用。',
    en: 'Running from source — update feeds only apply to packaged builds.',
  },
  updatesSupport: { zh: '问题咨询', en: 'Support' },
  updatesSupportEmail: { zh: '联系邮箱', en: 'Email' },
  updatesSupportSubtitle: {
    zh: '复制邮箱，发送问题与建议',
    en: 'Copy the support email to send questions',
  },
  updatesSupportCopied: { zh: '邮箱已复制', en: 'Email copied' },

  whatsNew: { zh: '更新内容', en: "What's New" },
  whatsNewSubtitle: { zh: '查看本机内置的版本更新说明', en: 'Release notes bundled with the app' },
  whatsNewSummary: {
    zh: '{versions} 个版本 · {changes} 条变更',
    en: '{versions} versions · {changes} changes',
  },
  whatsNewLatest: { zh: '最新', en: 'Latest' },
  whatsNewChangeCount: { zh: '{count} 条变更', en: '{count} changes' },
  whatsNewEmpty: { zh: '暂无更新记录', en: 'No release notes yet' },
  close: { zh: '关闭', en: 'Close' },

  updatePromptAvailableHint: {
    zh: '发现新版本。可立即下载，下载完成后重启安装。',
    en: 'A new version is available. Download it, then restart to install.',
  },
  updatePromptDownloadHint: {
    zh: '正在后台下载更新，请保持网络畅通。',
    en: 'Downloading the update in the background — keep your network connection active.',
  },
  updatePromptReadyHint: {
    zh: '更新已下载完成。点击「重启安装」将退出并完成升级。',
    en: 'Update downloaded. Click Restart to install to quit and finish the upgrade.',
  },
  updatePromptLater: { zh: '稍后', en: 'Later' },



  startupFailed: { zh: '启动失败', en: 'Startup failed' },
  startupFailedHint: {
    zh: '无法读取工具清单。开发环境下请先执行 npm run build:node 生成 dist-electron/。',
    en: 'The tool catalogue could not be loaded. In development, run `npm run build:node` first to generate dist-electron/.',
  },

  bridgeMissing: {
    zh: '未检测到桌面运行环境。请通过 MagiesPdf 应用打开，而不是浏览器。',
    en: 'Desktop runtime not detected. Open this through the MagiesPdf app, not a browser.',
  },
} as const;

export type UiKey = keyof typeof UI;

export function t(key: UiKey, locale: Locale): string {
  return UI[key][locale];
}

/** Resolves any bilingual value carried by a tool descriptor or an error. */
export function localized(text: LocalizedText | undefined, locale: Locale): string {
  return text ? text[locale] : '';
}

export function formatBytes(bytes: number, locale: Locale): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    maximumFractionDigits: value < 10 ? 1 : 0,
  })} ${units[unit]}`;
}
