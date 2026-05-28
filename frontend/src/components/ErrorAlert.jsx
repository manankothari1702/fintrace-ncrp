/**
 * Inline error banner for failed loads / actions. Accepts either an
 * {@link ApiError} (or any Error) via `error`, or an explicit `title` +
 * `message`. When the cause is retryable, pass `onRetry` to render a button.
 *
 * @param {object} props
 * @param {Error|import('../utils/api').ApiError|null} [props.error]
 * @param {string} [props.title='Something went wrong']
 * @param {string} [props.message] - Overrides error.message when provided.
 * @param {() => void} [props.onRetry]
 */
export default function ErrorAlert({ error, title = 'Something went wrong', message, onRetry }) {
  const detail = message || (error && error.message) || 'An unexpected error occurred.';
  const code = error && error.code ? error.code : null;

  return (
    <div className="error-alert" role="alert">
      <span className="error-icon" aria-hidden="true">⚠️</span>
      <div style={{ flex: 1 }}>
        <div className="error-title">{title}</div>
        <div className="error-detail">
          {detail}
          {code && code !== 'HTTP_ERROR' && (
            <span style={{ opacity: 0.7 }}> ({code})</span>
          )}
        </div>
      </div>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
