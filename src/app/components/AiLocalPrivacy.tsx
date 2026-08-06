import { clsx } from 'clsx';
import { hasBridge, type AiProvider } from '../bridge.ts';
import { type Locale } from '../i18n.ts';
import { HardDrive } from '../icons.ts';
import { PROVIDER_PRESETS, createProviderFromPreset } from '../ai/providers.ts';
import { Button } from './ui.tsx';
import { SettingCard, Toggle } from './settingsUi.tsx';
import { VendorMark } from './AiProviderList.tsx';

const LOCAL_VENDORS = ['ollama', 'lmstudio'];

/**
 * Running a model on this machine, and the switch that makes that the only
 * option allowed.
 *
 * The toggle is not cosmetic: `electron/ai/privacy.cjs` refuses any turn whose
 * endpoint is not loopback, and any turn handed to a CLI agent, while it is on.
 * It sits here rather than under Safety because the decision it expresses is
 * "which model may see my documents".
 */
export function AiLocalPrivacy({
  providers,
  strict,
  locale,
  onAddProvider,
  onSetStrict,
}: {
  providers: AiProvider[];
  strict: boolean;
  locale: Locale;
  onAddProvider(provider: AiProvider): void;
  onSetStrict(value: boolean): void;
}) {
  return (
    <SettingCard className="space-y-3 border-[color-mix(in_oklab,var(--success)_35%,transparent)] bg-[color-mix(in_oklab,var(--success)_5%,transparent)]">
      <div className="flex items-start gap-3">
        <span className="ai-plate h-10 w-10 shrink-0 rounded-xl bg-[var(--success-soft)] text-[var(--success)]">
          <HardDrive size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold">
            {locale === 'zh' ? '本地 / 隐私模型' : 'Local / private models'}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {locale === 'zh'
              ? '通过 Ollama 或 LM Studio 在本机运行模型。请求只走 localhost，不需要任何云端 API Key。'
              : 'Run a model on this machine with Ollama or LM Studio. Requests stay on localhost and need no cloud API key.'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {LOCAL_VENDORS.map((vendorId) => {
          const preset = PROVIDER_PRESETS.find((entry) => entry.id === vendorId);
          if (!preset) return null;
          const added = providers.some((provider) => provider.providerId === vendorId);
          return (
            <Button
              key={vendorId}
              size="sm"
              disabled={added || !hasBridge()}
              title={added ? (locale === 'zh' ? '已添加' : 'Already added') : undefined}
              onClick={() => onAddProvider(createProviderFromPreset(preset, () => crypto.randomUUID()))}
              className={clsx('gap-2', added && 'opacity-60')}
            >
              <VendorMark iconId={preset.id} fallback={preset.mark} size="sm" className="h-5 w-5 rounded-md" />
              {added
                ? (locale === 'zh' ? `已添加 ${preset.name}` : `${preset.name} added`)
                : (locale === 'zh' ? `添加 ${preset.name}` : `Add ${preset.name}`)}
            </Button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">
            {locale === 'zh' ? '严格本地隐私' : 'Strict local privacy'}
          </div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {locale === 'zh'
              ? '只允许回环地址的模型接口；云端服务商和命令行 Agent 的任务会被拒绝。'
              : 'Allows loopback model endpoints only; turns on a cloud provider or a CLI agent are refused.'}
          </div>
        </div>
        <Toggle
          checked={strict}
          disabled={!hasBridge()}
          ariaLabel={locale === 'zh' ? '严格本地隐私' : 'Strict local privacy'}
          onChange={onSetStrict}
        />
      </div>
    </SettingCard>
  );
}
