/**
 * The cut, at the size you would actually judge it at, and every piece it was made from.
 *
 * This is the whole reason the page is two columns rather than a chat box: the thing being
 * made is a video, and a video shown in the margin of a conversation is a video nobody can
 * tell is wrong.
 *
 * The shelf underneath matters for the same reason at a different scale. A two-minute film
 * is eight generations, each costing minutes and money, and judging the cut means being able
 * to look at the pieces -- which shot is soft, which one is the wrong length. A person who
 * can only see the assembly has to describe a problem they cannot point at.
 */
import { useState } from 'react'
import type { Delivered, Transcript } from './transcript'
import { deliveries, latestFinal } from './transcript'

export const Stage = ({ transcript, working }: { transcript: Transcript; working: boolean }) => {
  const cut = latestFinal(transcript)
  const pieces = deliveries(transcript)

  // What is on the big player: whatever was picked, or the most recent cut.
  const [picked, setPicked] = useState<string | null>(null)
  const showing = pieces.find((piece) => piece.id === picked) ?? cut

  return (
    <section className="stage">
      {showing === undefined || showing === null ? (
        <Empty working={working} />
      ) : (
        <Playing key={showing.id} piece={showing} />
      )}

      {pieces.length > 1 && (
        <ol className="shelf">
          {pieces.map((piece, at) => (
            <li key={piece.id}>
              <button
                type="button"
                className={piece.id === showing?.id ? 'piece on' : 'piece'}
                onClick={() => setPicked(piece.id)}
              >
                {/*
                  `#t=0.5` is what makes a thumbnail rather than a black rectangle: the
                  browser seeks there and paints that frame. Muted, because a shelf of clips
                  all talking at once is unusable.
                */}
                <video src={`${piece.url}#t=0.5`} muted playsInline preload="metadata" />
                <span className="label">{piece.role === 'final' ? 'Cut' : `Shot ${at + 1}`}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

const Playing = ({ piece }: { piece: Delivered }) => (
  // `controls` rather than a player of our own. Scrubbing, volume and fullscreen are
  // already right in the browser's, and a custom one would be worse at all three.
  <video className="cut" src={piece.url} controls autoPlay playsInline />
)

const Empty = ({ working }: { working: boolean }) => (
  <div className="empty">
    <p>{working ? 'Working on it.' : 'Nothing cut yet.'}</p>
    <p className="quiet">
      {working
        ? 'Generating footage takes a few minutes. Pieces appear here as they land.'
        : 'Describe the opener you want. Footage gets made if you have none.'}
    </p>
  </div>
)
