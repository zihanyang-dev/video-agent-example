/**
 * The cut, at the size you would actually judge it at.
 *
 * This is the whole reason the page is two columns rather than a chat box: the thing being
 * made is a video, and a video shown in the margin of a conversation is a video nobody can
 * tell is wrong.
 */
import type { Delivered, Transcript } from '../conversation/transcript'
import { latestFinal } from '../conversation/transcript'

export const Stage = ({ transcript, working }: { transcript: Transcript; working: boolean }) => {
  const cut = latestFinal(transcript)
  const previews = transcript.items.filter(
    (item): item is Delivered => item.kind === 'artifact' && item.role === 'preview',
  )

  return (
    <section className="stage">
      {cut === null ? <Empty working={working} /> : <Playing key={cut.id} url={cut.url} />}
      {previews.length > 0 && (
        <ol className="strip">
          {previews.map((preview) => (
            <li key={preview.id}>
              {/* Muted and loopable: a strip of previews all talking at once is unusable. */}
              <video src={preview.url} muted loop playsInline controls preload="metadata" />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

const Playing = ({ url }: { url: string }) => (
  // `controls` rather than a player of our own. Scrubbing, volume and fullscreen are
  // already right in the browser's, and a custom one would be worse at all three.
  <video className="cut" src={url} controls autoPlay playsInline />
)

const Empty = ({ working }: { working: boolean }) => (
  <div className="empty">
    <p>{working ? 'Working on it.' : 'Nothing cut yet.'}</p>
    <p className="quiet">
      {working
        ? 'Generating footage takes a few minutes. It will appear here.'
        : 'Describe the opener you want. Footage gets made if you have none.'}
    </p>
  </div>
)
