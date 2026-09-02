import { useState } from 'react'

const stringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function CopyButton({ value, testId }: { value: unknown; testId: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      data-testid={testId}
      className="rounded border border-border-subtle px-1.5 py-0.5 text-ui text-ink-muted hover:text-ink"
      onClick={() => {
        void navigator.clipboard?.writeText(
          typeof value === 'string' ? value : stringify(value),
        )
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

/**
 * Raw JSON, verbatim, always available (R5.3, R5.4). A normalised-only view is
 * what makes debugging a local model miserable — the interesting detail is
 * almost always the field nobody thought to surface.
 */
export function JsonBlock({
  value,
  testId,
  label,
  defaultOpen = false,
}: {
  value: unknown
  testId: string
  label?: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const text = stringify(value)

  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          className="text-ui text-ink-muted underline decoration-dotted hover:text-ink"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'} {label ?? 'raw JSON'} ({text.length} chars)
        </button>
        <CopyButton value={text} testId={`${testId}-copy`} />
      </div>
      {open && (
        <pre
          data-testid={testId}
          className="mt-1 max-h-80 overflow-auto rounded bg-surface-raised p-2 font-mono text-ui leading-relaxed"
        >
          {text}
        </pre>
      )}
    </div>
  )
}
