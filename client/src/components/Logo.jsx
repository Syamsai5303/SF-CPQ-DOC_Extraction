/**
 * StreamForce company logo (client/public/logo.png, 480x112 wordmark on white)
 * followed by the product name. The PNG has a white background, so place it on
 * white surfaces (header, cards).
 */
export default function Logo({ size = 'md', showName = true }) {
  const img = size === 'lg' ? 'h-10' : 'h-8';
  return (
    <span className="inline-flex items-center gap-3">
      <img src="/logo.png" alt="StreamForce" className={`${img} w-auto shrink-0`} />
      {showName && (
        <>
          <span className="h-6 w-px bg-slate-200" aria-hidden="true" />
          <span className={`font-semibold tracking-tight text-slate-900 ${size === 'lg' ? 'text-lg' : 'text-base'}`}>
            CPQ <span className="text-brand-600">→</span> RCA
          </span>
        </>
      )}
    </span>
  );
}
