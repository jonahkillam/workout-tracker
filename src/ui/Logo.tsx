/** The app's logo, the same drawing as public/favicon.svg. Colour comes from `.logo` in index.css. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="6" y="5" width="20" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="11" y="2.5" width="10" height="5" rx="1.5" fill="currentColor" />
      <rect x="10" y="19" width="2.5" height="6" fill="currentColor" />
      <rect x="14.75" y="12" width="2.5" height="13" fill="currentColor" />
      <rect x="19.5" y="16" width="2.5" height="9" fill="currentColor" />
    </svg>
  )
}
