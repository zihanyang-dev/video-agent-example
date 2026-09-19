/**
 * What the agent wrote, with the small amount of markdown it actually writes.
 *
 * A model writes `**like this**` whether or not anyone asked it to, and a screen that shows
 * the asterisks looks broken. This handles the two marks that turn up in practice -- bold
 * and blank lines -- and leaves everything else as the text it is.
 *
 * Deliberately not a markdown library and deliberately not `dangerouslySetInnerHTML`. This
 * text comes from a model, which means it is partly written by whoever wrote the brief; it
 * is turned into React nodes, so there is no path from a message to markup.
 */
import { Fragment, type ReactNode } from 'react'

export const Said = ({ text }: { text: string }) => (
  <>
    {text.split('\n').map((line, index) => (
      // Lines have no ids of their own, and the text is replaced wholesale on every delta,
      // so there is nothing for a stable key to preserve.
      // eslint-disable-next-line react/no-array-index-key
      <Fragment key={index}>
        {index > 0 && <br />}
        {emphasised(line)}
      </Fragment>
    ))}
  </>
)

/** Splits on `**...**`, keeping the delimiters so the odd segments are the bold ones. */
const emphasised = (line: string): ReactNode[] =>
  line
    .split(/\*\*(.+?)\*\*/g)
    .map((part, index) =>
      index % 2 === 1 ? (
        <strong key={index}>{part}</strong>
      ) : (
        <Fragment key={index}>{part}</Fragment>
      ),
    )
