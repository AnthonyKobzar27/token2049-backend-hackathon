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

/**
 * The big glossy hero hand of the dark HaaS landing: cream palm with the face,
 * four upright fingers and a thumb, shaded with gradients to read as soft 3D.
 */
export function BigHand({ size = 460 }: { size?: number }) {
  return (
    <svg width={size} height={size * (600 / 620)} viewBox="0 0 620 600" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id="bh-palm" cx="38%" cy="28%" r="90%">
          <stop offset="0%" stopColor="#fdf7ea" />
          <stop offset="55%" stopColor="#f3e3c6" />
          <stop offset="100%" stopColor="#e0c79f" />
        </radialGradient>
        <linearGradient id="bh-finger" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#faf0dc" />
          <stop offset="100%" stopColor="#e7d1ab" />
        </linearGradient>
        <radialGradient id="bh-eye" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#403e5e" />
          <stop offset="70%" stopColor="#262539" />
        </radialGradient>
      </defs>
      {/* thumb and fingers, behind the palm */}
      <rect x="50" y="300" width="120" height="210" rx="60" fill="url(#bh-finger)" transform="rotate(48 110 405)" />
      <rect x="150" y="70" width="104" height="300" rx="52" fill="url(#bh-finger)" transform="rotate(-10 202 220)" />
      <rect x="268" y="28" width="108" height="320" rx="54" fill="url(#bh-finger)" transform="rotate(-2 322 188)" />
      <rect x="386" y="48" width="104" height="300" rx="52" fill="url(#bh-finger)" transform="rotate(7 438 198)" />
      <rect x="488" y="110" width="92" height="250" rx="46" fill="url(#bh-finger)" transform="rotate(16 534 235)" />
      {/* finger sheen */}
      <ellipse cx="300" cy="90" rx="22" ry="48" fill="#ffffff" opacity="0.35" />
      <ellipse cx="420" cy="110" rx="20" ry="44" fill="#ffffff" opacity="0.28" transform="rotate(7 420 110)" />
      {/* palm */}
      <ellipse cx="330" cy="400" rx="252" ry="186" fill="url(#bh-palm)" transform="rotate(-8 330 400)" />
      <ellipse cx="248" cy="312" rx="118" ry="56" fill="#ffffff" opacity="0.32" transform="rotate(-16 248 312)" />
      {/* face */}
      <circle cx="255" cy="395" r="16" fill="url(#bh-eye)" />
      <circle cx="260" cy="389" r="5" fill="#ffffff" opacity="0.9" />
      <circle cx="398" cy="383" r="16" fill="url(#bh-eye)" />
      <circle cx="403" cy="377" r="5" fill="#ffffff" opacity="0.9" />
      <path d="M 268 432 Q 328 484 390 426" stroke="#2b2a44" strokeWidth="20" strokeLinecap="round" fill="none" />
      <ellipse cx="200" cy="448" rx="25" ry="17" fill="#f3bfcb" opacity="0.85" />
      <ellipse cx="452" cy="472" rx="22" ry="15" fill="#f3bfcb" opacity="0.85" />
    </svg>
  );
}
