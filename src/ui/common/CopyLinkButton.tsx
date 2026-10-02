import { useState } from 'react'
import { linkUrl, type Link } from '../../nav/link'

/** Copies a link to a week or workout. The address bar never shows one, so this is the way to get it. */
export function CopyLinkButton({ link, short }: { link: Link; short?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const url = linkUrl(window.location.origin, link)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // No clipboard access (e.g. plain http): show the link to copy by hand.
      window.prompt('Link', url)
    }
  }
  return (
    <button onClick={() => void copy()}>
      {copied ? (
        'Copied'
      ) : short ? (
        <>
          <span className="wide-only">Copy link</span>
          <span className="narrow-only">Link</span>
        </>
      ) : (
        'Copy link'
      )}
    </button>
  )
}
