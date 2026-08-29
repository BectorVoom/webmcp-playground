/**
 * R5.13: an error reaches the user as a tag, a sentence, a remedy and its
 * correlation ids — never a bare object and never an unlabelled stack.
 */
export function ErrorNotice({
  tag,
  message,
  remedy,
  correlation,
  testId,
  variant = 'error',
}: {
  tag: string
  message: string
  remedy?: string
  correlation?: ReadonlyArray<string | undefined>
  testId: string
  variant?: 'error' | 'warn'
}) {
  const ids = (correlation ?? []).filter(Boolean)
  const tone =
    variant === 'error'
      ? 'border-danger/40 bg-danger/10 text-danger'
      : 'border-warn/40 bg-warn/10 text-warn'

  return (
    <div data-testid={testId} className={`rounded border px-2 py-1.5 text-xs ${tone}`}>
      <div className="font-mono font-semibold" data-testid={`${testId}-tag`}>
        {tag}
      </div>
      <div className="mt-0.5 text-ink">{message}</div>
      {remedy !== undefined && (
        <div className="mt-1 text-ink-muted" data-testid={`${testId}-remedy`}>
          → {remedy}
        </div>
      )}
      {ids.length > 0 && (
        <div className="mt-1 font-mono text-[10px] text-ink-muted">{ids.join(' · ')}</div>
      )}
    </div>
  )
}
