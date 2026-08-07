import { useState } from 'react';
import { Bot, Check, FileText, FolderOpen, X } from '../icons.ts';
import { t, type Locale } from '../i18n.ts';
import { Button } from './ui.tsx';

interface OnboardingWizardProps {
  open: boolean;
  locale: Locale;
  /** `dontShowAgain` decides whether this is the last time the tour appears. */
  onClose(dontShowAgain: boolean): void;
  onOpenSettings?(): void;
}

/**
 * 3-step first-launch welcome modal.
 * Introduces PDF Workspace, Bundled Office, and Local AI Automation.
 *
 * Whether it comes back is the user's call, taken from the checkbox below and
 * honoured on every exit — skip, close and finish alike.
 */
export function OnboardingWizard({ open, locale, onClose, onOpenSettings }: OnboardingWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Unticked by default: keeping the tour is the passive outcome, and only a
  // deliberate tick turns it off for good.
  const [dontShowAgain, setDontShowAgain] = useState(false);

  if (!open) return null;

  const handleClose = () => onClose(dontShowAgain);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="surface-panel relative w-full max-w-lg overflow-hidden rounded-2xl shadow-2xl border border-[var(--border-subtle)]">
        {/* Close / Skip button */}
        <button
          type="button"
          onClick={handleClose}
          className="absolute top-3 right-3 rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          aria-label={t('close', locale)}
        >
          <X size={16} />
        </button>

        {/* Header / Step indicator */}
        <div className="border-b border-[var(--border-subtle)] px-6 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]">
              {step} / 3
            </span>
            <h2 className="text-base font-semibold tracking-tight">
              {step === 1 && (locale === 'zh' ? '欢迎使用 Magies Office' : 'Welcome to Magies Office')}
              {step === 2 && (locale === 'zh' ? '三大核心处理模式' : 'Three Core Processing Modes')}
              {step === 3 && (locale === 'zh' ? '本地 AI 自动化处理' : 'Local AI Automation')}
            </h2>
          </div>
        </div>

        {/* Content per step */}
        <div className="px-6 py-5 min-h-[220px]">
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                {/* The product's own mark on the page that introduces it; the
                    robot belongs on the step about the assistant. */}
                <img
                  src={`${import.meta.env.BASE_URL}logo.png`}
                  alt=""
                  width={64}
                  height={64}
                  draggable={false}
                  className="h-16 w-16 select-none"
                />
              </div>
              <p className="text-center text-sm leading-relaxed text-[var(--text-secondary)]">
                {locale === 'zh'
                  ? 'Magies Office 是专为 Word、Excel、PowerPoint 和 PDF 打造的本地优先桌面工作区。无需上传，无需注册，所有文档操作均在本机完成。'
                  : 'Magies Office is a local-first desktop workspace for Word, Excel, PowerPoint, and PDF. No uploads, no account needed, everything runs locally.'}
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
                <FileText size={18} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <div className="text-xs">
                  <p className="font-semibold text-[var(--text-primary)]">
                    {locale === 'zh' ? '1. PDF 工作区' : '1. PDF Workspace'}
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    {locale === 'zh'
                      ? '多标签页阅读、合并、拆分、加水印、文本标注、高亮与签名。'
                      : 'Multi-tab PDF view, merge, split, watermark, highlight & sign.'}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
                <FolderOpen size={18} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <div className="text-xs">
                  <p className="font-semibold text-[var(--text-primary)]">
                    {locale === 'zh' ? '2. 内置引擎编辑器' : '2. Built-in Engine Editor'}
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    {locale === 'zh'
                      ? '原生创建和编辑 Word (.docx)、Excel (.xlsx)、PowerPoint (.pptx) 文档。'
                      : 'Create and edit Word, Excel, PowerPoint documents natively.'}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
                <Bot size={18} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <div className="text-xs">
                  <p className="font-semibold text-[var(--text-primary)]">
                    {locale === 'zh' ? '3. 智能体与 MCP' : '3. AI Agent & MCP'}
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    {locale === 'zh'
                      ? '支持 OpenAI / Ollama 等兼容模型，授权本地目录后自动处理和归档。'
                      : 'Connect OpenAI/Ollama models for automated folder workflows.'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <Bot size={28} />
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">
                  {locale === 'zh' ? '配置你的 AI 模型' : 'Configure Your AI Model'}
                </h3>
                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                  {locale === 'zh'
                    ? '只需在设置中填写 OpenAI / DeepSeek / Ollama 等兼容 API 地址与 API Key，即可开启 AI 办公助手。'
                    : 'Simply fill in your OpenAI / DeepSeek / Ollama API URL and Key in Settings to get started.'}
                </p>
              </div>
              {onOpenSettings && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    handleClose();
                    onOpenSettings();
                  }}
                  className="mx-auto text-xs"
                >
                  {t('aiOpenSettings', locale)}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button size="sm" variant="ghost" onClick={handleClose}>
              {locale === 'zh' ? '跳过' : 'Skip'}
            </Button>
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(event) => setDontShowAgain(event.target.checked)}
                className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
              />
              {locale === 'zh' ? '下次不再显示' : "Don't show again"}
            </label>
          </div>

          <div className="flex items-center gap-2">
            {step > 1 && (
              <Button size="sm" variant="ghost" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>
                {locale === 'zh' ? '上一步' : 'Back'}
              </Button>
            )}
            {step < 3 ? (
              <Button size="sm" variant="primary" onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}>
                {locale === 'zh' ? '下一步' : 'Next'}
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={handleClose}>
                <Check size={14} />
                {locale === 'zh' ? '开始使用' : 'Get Started'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
