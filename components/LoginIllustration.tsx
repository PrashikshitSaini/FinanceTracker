export default function LoginIllustration() {
  return (
    <svg
      viewBox="0 0 400 300"
      className="w-full h-full max-w-md mx-auto"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Background gradient circle */}
      <defs>
        <linearGradient id="gradient1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.1" />
        </linearGradient>
        <linearGradient id="gradient2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.1" />
        </linearGradient>
        <linearGradient id="gradient3" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      {/* Floating circles */}
      <circle cx="80" cy="60" r="40" fill="url(#gradient1)" />
      <circle cx="320" cy="80" r="35" fill="url(#gradient2)" />
      <circle cx="200" cy="240" r="45" fill="url(#gradient3)" />

      {/* Wallet icon */}
      <g transform="translate(150, 100)">
        {/* Wallet body */}
        <rect
          x="20"
          y="30"
          width="60"
          height="45"
          rx="8"
          fill="#3b82f6"
          opacity="0.9"
        />
        <rect
          x="20"
          y="30"
          width="60"
          height="20"
          rx="8"
          fill="#2563eb"
        />
        
        {/* Wallet flap */}
        <path
          d="M 20 30 Q 50 25 80 30"
          stroke="#1e40af"
          strokeWidth="2"
          fill="none"
        />
        
        {/* Cards inside wallet */}
        <rect
          x="25"
          y="35"
          width="50"
          height="8"
          rx="2"
          fill="#ffffff"
          opacity="0.9"
        />
        <rect
          x="25"
          y="47"
          width="50"
          height="8"
          rx="2"
          fill="#ffffff"
          opacity="0.7"
        />
        
        {/* Money symbol */}
        <text
          x="50"
          y="65"
          fontSize="20"
          fill="#ffffff"
          fontWeight="bold"
          textAnchor="middle"
        >
          $
        </text>
      </g>

      {/* Chart bars */}
      <g transform="translate(50, 180)">
        {/* Bar 1 */}
        <rect x="0" y="30" width="25" height="50" rx="4" fill="#10b981" opacity="0.8" />
        {/* Bar 2 */}
        <rect x="35" y="20" width="25" height="60" rx="4" fill="#3b82f6" opacity="0.8" />
        {/* Bar 3 */}
        <rect x="70" y="40" width="25" height="40" rx="4" fill="#8b5cf6" opacity="0.8" />
        {/* Bar 4 */}
        <rect x="105" y="10" width="25" height="70" rx="4" fill="#f59e0b" opacity="0.8" />
        {/* Bar 5 */}
        <rect x="140" y="25" width="25" height="55" rx="4" fill="#ec4899" opacity="0.8" />
      </g>

      {/* Floating coins */}
      <circle cx="100" cy="120" r="8" fill="#fbbf24" opacity="0.7">
        <animate
          attributeName="cy"
          values="120;110;120"
          dur="3s"
          repeatCount="indefinite"
        />
      </circle>
      <circle cx="300" cy="200" r="6" fill="#fbbf24" opacity="0.7">
        <animate
          attributeName="cy"
          values="200;190;200"
          dur="2.5s"
          repeatCount="indefinite"
        />
      </circle>
      <circle cx="350" cy="150" r="7" fill="#fbbf24" opacity="0.7">
        <animate
          attributeName="cy"
          values="150;140;150"
          dur="3.5s"
          repeatCount="indefinite"
        />
      </circle>

      {/* Sparkle effects */}
      <g opacity="0.6">
        <circle cx="60" cy="140" r="2" fill="#3b82f6">
          <animate
            attributeName="opacity"
            values="0.3;1;0.3"
            dur="2s"
            repeatCount="indefinite"
          />
        </circle>
        <circle cx="340" cy="120" r="2" fill="#8b5cf6">
          <animate
            attributeName="opacity"
            values="0.3;1;0.3"
            dur="2.5s"
            repeatCount="indefinite"
          />
        </circle>
        <circle cx="180" cy="50" r="2" fill="#10b981">
          <animate
            attributeName="opacity"
            values="0.3;1;0.3"
            dur="1.8s"
            repeatCount="indefinite"
          />
        </circle>
      </g>

      {/* Trend line */}
      <path
        d="M 50 200 Q 100 180, 150 190 T 250 185 T 350 195"
        stroke="#3b82f6"
        strokeWidth="3"
        fill="none"
        opacity="0.6"
        strokeLinecap="round"
      >
        <animate
          attributeName="stroke-dasharray"
          values="0,400;400,0"
          dur="4s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}
