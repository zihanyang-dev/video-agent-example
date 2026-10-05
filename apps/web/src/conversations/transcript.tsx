import { AssetLinks } from '../assets/asset-links'
import type { FailedRun } from '@vid/contract/http'
import type { TranscriptMessage } from './run-view'

export function Transcript({
  messages,
  failedRuns = [],
}: {
  messages: readonly TranscriptMessage[]
  failedRuns?: readonly FailedRun[]
}) {
  return (
    <section className="transcript" aria-label="Transcript" aria-live="polite">
      {messages.length ? (
        messages.map((message) => (
          <Message
            key={message.messageID}
            message={message}
            failures={failedRuns.filter(
              (run) => run.messageID === message.messageID,
            )}
          />
        ))
      ) : (
        <EmptyTranscript />
      )}
    </section>
  )
}

function Message({
  message,
  failures,
}: {
  message: TranscriptMessage
  failures: readonly FailedRun[]
}) {
  const label =
    message.role === 'user'
      ? 'You'
      : message.role === 'assistant'
        ? 'Video assistant'
        : message.role

  return (
    <article
      className={`message ${message.role === 'user' ? 'user' : 'assistant'}`}
    >
      <h2>{label}</h2>
      {message.assets && <AssetLinks assets={message.assets} />}
      <p>{message.text || '…'}</p>
      {failures.map((run) => (
        <p key={run.runID} role="alert">
          {failureMessage(run.reason)}
        </p>
      ))}
    </article>
  )
}

function failureMessage(reason: FailedRun['reason']) {
  switch (reason) {
    case 'execution-error':
      return 'The run could not finish. Check Chat history and ask the operator to verify the execution environment before retrying.'
    case 'interrupted':
      return 'The run was interrupted. Check Chat history and ask the operator to verify the execution environment before retrying.'
    case 'sandbox-recovery-required':
      return 'The execution environment needs recovery before another run.'
  }
}

function EmptyTranscript() {
  return (
    <div className="empty">
      <h2>Every video starts with an idea.</h2>
      <p>
        Describe a scene, a mood, or a story. Your conversation will appear
        here.
      </p>
    </div>
  )
}
