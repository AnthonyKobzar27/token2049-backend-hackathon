/** The HumanRouter hand: peach fingers, round palm, happy face. */
export function Mascot({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size * (460 / 540)} viewBox="0 0 540 460" fill="none" aria-hidden="true">
      {/* thumb */}
      <rect x="52" y="218" width="92" height="170" rx="46" fill="#F9BE98" transform="rotate(42 98 303)" />
      {/* fingers */}
      <rect x="146" y="120" width="80" height="230" rx="40" fill="#F9BE98" />
      <rect x="216" y="52" width="80" height="260" rx="40" fill="#F9BE98" />
      <rect x="290" y="46" width="80" height="260" rx="40" fill="#F9BE98" />
      <rect x="362" y="104" width="72" height="230" rx="36" fill="#F9BE98" />
      {/* palm */}
      <rect x="142" y="182" width="300" height="238" rx="112" fill="#FBCD9F" />
      {/* face */}
      <circle cx="238" cy="290" r="17" fill="#221B4F" />
      <circle cx="340" cy="290" r="17" fill="#221B4F" />
      <circle cx="196" cy="332" r="21" fill="#F7A3B5" />
      <circle cx="382" cy="332" r="21" fill="#F7A3B5" />
      <path d="M 250 330 Q 289 366 328 330" stroke="#221B4F" strokeWidth="17" strokeLinecap="round" fill="none" />
    </svg>
  );
}
