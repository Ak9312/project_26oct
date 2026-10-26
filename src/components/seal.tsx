/** Brand mark: a simple document seal. */
export function Seal({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="seal">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="0.75" strokeDasharray="1.6 1.6" />
      <path d="M11 9.5h6.2a4 4 0 0 1 0 8H13.4V22.5H11z M13.4 11.7v3.6h3.6a1.8 1.8 0 0 0 0-3.6z" fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
