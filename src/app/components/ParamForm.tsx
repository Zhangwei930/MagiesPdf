import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import type { ParamSpec, ParamValues } from '@core/types.ts';
import { bridge } from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import { ChevronDown, ChevronRight } from '../icons.ts';
import { pageRangePreset, partitionToolParams } from '../toolForm.ts';
import { Field } from './ui.tsx';

/**
 * Renders a tool's parameter form straight from its descriptor.
 *
 * Nothing here is tool-specific: adding a tool with new options needs no UI work,
 * which is the whole point of keeping the descriptor as the single source of truth.
 */

interface ParamFormProps {
  params: readonly ParamSpec[];
  values: ParamValues;
  locale: Locale;
  disabled?: boolean;
  onChange(values: ParamValues): void;
}

export function ParamForm({ params, values, locale, disabled, onChange }: ParamFormProps) {
  const [showMore, setShowMore] = useState(false);

  const { primary, more } = useMemo(
    () => partitionToolParams(params, values),
    [params, values],
  );

  const set = (key: string, value: ParamValues[string]) => onChange({ ...values, [key]: value });

  if (params.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {primary.map((param) => (
        <ParamControl
          key={param.key}
          param={param}
          value={values[param.key]}
          locale={locale}
          disabled={disabled}
          onChange={(value) => set(param.key, value)}
        />
      ))}

      {more.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setShowMore((open) => !open)}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            {showMore ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t('moreSettings', locale)}
            <span className="text-[var(--text-muted)]">({more.length})</span>
          </button>

          {showMore && (
            <div className="mt-3 space-y-4 border-l-2 border-[var(--border-subtle)] pl-4">
              {more.map((param) => (
                <ParamControl
                  key={param.key}
                  param={param}
                  value={values[param.key]}
                  locale={locale}
                  disabled={disabled}
                  onChange={(value) => set(param.key, value)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ControlProps {
  param: ParamSpec;
  value: unknown;
  locale: Locale;
  disabled?: boolean;
  onChange(value: ParamValues[string]): void;
}

function ParamControl({ param, value, locale, disabled, onChange }: ControlProps) {
  const id = `param-${param.key}`;
  const label = param.label[locale];
  const help = param.help?.[locale];

  switch (param.type) {
    case 'boolean':
      return (
        <label
          htmlFor={id}
          className={clsx(
            'flex cursor-pointer items-start gap-2.5',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <input
            id={id}
            type="checkbox"
            disabled={disabled}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-[var(--text-primary)]">{label}</span>
            {help && <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-muted)]">{help}</span>}
          </span>
        </label>
      );

    case 'select':
      if (param.options.length <= 4) {
        return (
          <Field label={label} help={help}>
            <div
              role="radiogroup"
              aria-label={label}
              className="grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${param.options.length}, minmax(0, 1fr))` }}
            >
              {param.options.map((option) => {
                const selected = String(value ?? param.default) === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={disabled}
                    onClick={() => onChange(option.value)}
                    className={clsx(
                      'min-h-9 rounded-lg border px-2 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-60',
                      selected
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {option.label[locale]}
                  </button>
                );
              })}
            </div>
          </Field>
        );
      }
      return (
        <Field label={label} help={help} htmlFor={id}>
          <select
            id={id}
            className="field-input"
            disabled={disabled}
            value={String(value ?? param.default)}
            onChange={(e) => onChange(e.target.value)}
          >
            {param.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label[locale]}
              </option>
            ))}
          </select>
        </Field>
      );

    case 'multiselect': {
      const selected = new Set(Array.isArray(value) ? value.map(String) : []);
      return (
        <Field label={label} help={help}>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {param.options.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-2 transition-colors hover:border-[var(--border-strong)]"
              >
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected.has(option.value)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(option.value);
                    else next.delete(option.value);
                    onChange([...next]);
                  }}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-[13px]">{option.label[locale]}</span>
                  {option.help && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-muted)]">
                      {option.help[locale]}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </Field>
      );
    }

    case 'number':
      return (
        <Field label={label} help={help} htmlFor={id}>
          <div className="flex items-center gap-2">
            <input
              id={id}
              type="number"
              className="field-input"
              disabled={disabled}
              value={Number(value ?? param.default)}
              min={param.min}
              max={param.max}
              step={param.step ?? (param.integer ? 1 : 'any')}
              onChange={(e) => onChange(e.target.value === '' ? param.default : Number(e.target.value))}
            />
            {param.unit && (
              <span className="shrink-0 text-xs text-[var(--text-muted)]">{param.unit[locale]}</span>
            )}
          </div>
        </Field>
      );

    case 'color':
      return (
        <Field label={label} help={help} htmlFor={id}>
          <div className="flex items-center gap-2">
            <input
              id={id}
              type="color"
              disabled={disabled}
              value={String(value ?? param.default)}
              onChange={(e) => onChange(e.target.value)}
              className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-[var(--border-subtle)] bg-transparent p-1"
            />
            <input
              type="text"
              className="field-input font-mono"
              disabled={disabled}
              value={String(value ?? param.default)}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
            />
          </div>
        </Field>
      );

    case 'password':
      return (
        <Field label={label} help={help} htmlFor={id}>
          <input
            id={id}
            type="password"
            className="field-input"
            disabled={disabled}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      );

    case 'pageRange': {
      const selected = pageRangePreset(value);
      const presets = [
        { value: 'all', label: t('pageRangeAll', locale) },
        { value: 'odd', label: t('pageRangeOdd', locale) },
        { value: 'even', label: t('pageRangeEven', locale) },
        { value: 'custom', label: t('pageRangeCustom', locale) },
      ] as const;
      return (
        <Field label={label} help={help}>
          <div className="grid grid-cols-4 gap-1.5">
            {presets.map((preset) => (
              <button
                key={preset.value}
                type="button"
                aria-pressed={selected === preset.value}
                disabled={disabled}
                onClick={() => {
                  if (preset.value === 'custom') {
                    if (selected !== 'custom') onChange('');
                    return;
                  }
                  onChange(preset.value);
                }}
                className={clsx(
                  'h-9 rounded-lg border px-1.5 text-[12px] font-medium transition-colors disabled:opacity-60',
                  selected === preset.value
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          {selected === 'custom' && (
            <input
              id={id}
              type="text"
              className="field-input mt-2 font-mono"
              disabled={disabled}
              value={String(value ?? '')}
              onChange={(e) => onChange(e.target.value)}
              placeholder="1-3, 5, 8-"
              spellCheck={false}
            />
          )}
        </Field>
      );
    }

    case 'file':
      return (
        <Field label={label} help={help} htmlFor={id}>
          <div className="flex gap-2">
            <input
              id={id}
              type="text"
              className="field-input min-w-0 flex-1"
              disabled={disabled}
              value={String(value ?? '')}
              readOnly
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                void bridge().pickFiles(param.accept, false).then(([file]) => {
                  if (file) onChange(file.path);
                });
              }}
              className="shrink-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-60"
            >
              {t('chooseFile', locale)}
            </button>
          </div>
        </Field>
      );

    case 'text':
      return (
        <Field label={label} help={help} htmlFor={id}>
          {param.multiline ? (
            <textarea
              id={id}
              rows={3}
              className="field-input resize-y"
              disabled={disabled}
              value={String(value ?? '')}
              placeholder={param.placeholder?.[locale]}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              id={id}
              type="text"
              className="field-input"
              disabled={disabled}
              value={String(value ?? '')}
              placeholder={param.placeholder?.[locale]}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </Field>
      );
  }
}
