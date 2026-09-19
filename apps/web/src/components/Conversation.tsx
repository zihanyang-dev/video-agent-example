/**
 * What was said, and what is being done about it.
 *
 * Each item renders by kind. Nothing here inspects an id, a path, or anything the agent ran:
 * if it is on this screen, a rule in `transcript.ts` put it there (architecture.md §6).
 */
import { useEffect, useRef } from 'react'
import type { Item, Transcript } from '../conversation/transcript'
import { Said } from './Said'

export const Conversation = ({ transcript }: { transcript: Transcript }) => {
  const end = useRef<HTMLDivElement>(null)

  // Follows the bottom as things arrive. Deliberately unconditional: this panel is a live
  // log, and a reply that streams in above the fold is one nobody reads.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [transcript.items])

  return (
    <div className="conversation">
      {transcript.items.map((item) => (
        <Line key={item.id} item={item} />
      ))}
      {transcript.broke !== null && <p className="broke">{transcript.broke}</p>}
      <div ref={end} />
    </div>
  )
}

const Line = ({ item }: { item: Item }) => {
  switch (item.kind) {
    case 'said':
      return <Spoken item={item} />
    case 'thought':
      return <Thought item={item} />
    case 'step':
      return <Step item={item} />
    // Delivered things live on the stage. A second copy here would be the same video twice
    // on one screen, and the one in the column would be the one too small to judge.
    case 'artifact':
      return (
        <p className="delivered">
          {item.role === 'final' ? 'Delivered a cut' : 'Delivered something to look at'}
        </p>
      )
    case 'ask':
      return <Ask item={item} />
  }
}

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>

const Spoken = ({ item }: { item: Of<'said'> }) => {
  // An empty bubble with a caret in it is how a reply that has started but said nothing yet
  // looks; an empty one that has finished is nothing at all, so it is not drawn.
  if (item.text === '' && item.finished) return null

  return (
    <p className={item.from === 'person' ? 'said person' : 'said agent'}>
      <Said text={item.text} />
      {!item.finished && <span className="cursor" />}
    </p>
  )
}

/**
 * Collapsed by default and never auto-opened: this is the agent reasoning to itself, which
 * is worth being able to see and not worth reading by default.
 */
const Thought = ({ item }: { item: Of<'thought'> }) => {
  if (item.text.trim() === '') return null

  return (
    <details className="thought">
      <summary>Thinking</summary>
      <p>{item.text}</p>
    </details>
  )
}

const Step = ({ item }: { item: Of<'step'> }) => (
  <p className={`step ${item.state}`}>
    <span className="dot" aria-hidden="true" />
    {item.label}
    {item.detail !== undefined && <span className="detail">{item.detail}</span>}
  </p>
)

const Ask = ({ item }: { item: Of<'ask'> }) => (
  <div className="ask">
    <p>{item.question}</p>
    {item.answer === null ? (
      <ul>
        {item.options.map((option) => (
          <li key={option}>{option}</li>
        ))}
      </ul>
    ) : (
      <p className="answered">{item.answer}</p>
    )}
  </div>
)
