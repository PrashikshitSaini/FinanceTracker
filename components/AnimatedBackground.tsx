export default function AnimatedBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-black">
      <svg
        className="absolute inset-0 h-full w-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Gradient definitions for floating orbs - Enhanced visibility */}
          <radialGradient id="grad1" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: '#ffffff', stopOpacity: 1 }} />
            <stop offset="50%" style={{ stopColor: '#ffffff', stopOpacity: 0.4 }} />
            <stop offset="100%" style={{ stopColor: '#ffffff', stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="grad2" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: '#60a5fa', stopOpacity: 0.9 }} />
            <stop offset="50%" style={{ stopColor: '#3b82f6', stopOpacity: 0.5 }} />
            <stop offset="100%" style={{ stopColor: '#3b82f6', stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="grad3" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: '#f472b6', stopOpacity: 0.9 }} />
            <stop offset="50%" style={{ stopColor: '#ec4899', stopOpacity: 0.5 }} />
            <stop offset="100%" style={{ stopColor: '#ec4899', stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="grad4" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: '#34d399', stopOpacity: 0.9 }} />
            <stop offset="50%" style={{ stopColor: '#10b981', stopOpacity: 0.5 }} />
            <stop offset="100%" style={{ stopColor: '#10b981', stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id="grad5" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: '#a78bfa', stopOpacity: 0.9 }} />
            <stop offset="50%" style={{ stopColor: '#8b5cf6', stopOpacity: 0.5 }} />
            <stop offset="100%" style={{ stopColor: '#8b5cf6', stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        {/* Large floating orbs - More visible */}
        <circle cx="10%" cy="20%" r="350" fill="url(#grad1)" opacity="0.6">
          <animate
            attributeName="cx"
            values="10%;15%;10%"
            dur="20s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="cy"
            values="20%;25%;20%"
            dur="25s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="90%" cy="30%" r="280" fill="url(#grad2)" opacity="0.7">
          <animate
            attributeName="cx"
            values="90%;85%;90%"
            dur="18s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="cy"
            values="30%;35%;30%"
            dur="22s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="80%" cy="80%" r="240" fill="url(#grad3)" opacity="0.6">
          <animate
            attributeName="cx"
            values="80%;75%;80%"
            dur="15s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="cy"
            values="80%;75%;80%"
            dur="20s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="20%" cy="70%" r="220" fill="url(#grad4)" opacity="0.7">
          <animate
            attributeName="cx"
            values="20%;25%;20%"
            dur="17s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="cy"
            values="70%;65%;70%"
            dur="19s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="50%" cy="50%" r="260" fill="url(#grad5)" opacity="0.5">
          <animate
            attributeName="r"
            values="260;280;260"
            dur="12s"
            repeatCount="indefinite"
          />
        </circle>

        {/* Medium floating circles - More visible */}
        <circle cx="30%" cy="40%" r="100" fill="url(#grad2)" opacity="0.6">
          <animate
            attributeName="cx"
            values="30%;35%;30%"
            dur="10s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="70%" cy="60%" r="90" fill="url(#grad3)" opacity="0.6">
          <animate
            attributeName="cy"
            values="60%;55%;60%"
            dur="8s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="60%" cy="20%" r="95" fill="url(#grad4)" opacity="0.6">
          <animate
            attributeName="cx"
            values="60%;65%;60%"
            dur="9s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="15%" cy="85%" r="70" fill="url(#grad1)" opacity="0.7">
          <animate
            attributeName="cy"
            values="85%;80%;85%"
            dur="11s"
            repeatCount="indefinite"
          />
        </circle>

        {/* Small animated bright dots */}
        <circle cx="25%" cy="15%" r="3" fill="#ffffff" opacity="0.8">
          <animate
            attributeName="opacity"
            values="0.8;0.3;0.8"
            dur="3s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="75%" cy="25%" r="2" fill="#60a5fa" opacity="0.9">
          <animate
            attributeName="opacity"
            values="0.9;0.4;0.9"
            dur="2.5s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="85%" cy="70%" r="3" fill="#f472b6" opacity="0.7">
          <animate
            attributeName="opacity"
            values="0.7;0.2;0.7"
            dur="3.5s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="40%" cy="80%" r="2" fill="#34d399" opacity="0.8">
          <animate
            attributeName="opacity"
            values="0.8;0.3;0.8"
            dur="2.8s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="65%" cy="45%" r="2" fill="#ffffff" opacity="0.6">
          <animate
            attributeName="opacity"
            values="0.6;0.2;0.6"
            dur="3.2s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="10%" cy="50%" r="2" fill="#60a5fa" opacity="0.7">
          <animate
            attributeName="opacity"
            values="0.7;0.3;0.7"
            dur="2.7s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="90%" cy="55%" r="3" fill="#f472b6" opacity="0.8">
          <animate
            attributeName="opacity"
            values="0.8;0.4;0.8"
            dur="3.3s"
            repeatCount="indefinite"
          />
        </circle>

        <circle cx="55%" cy="90%" r="2" fill="#34d399" opacity="0.6">
          <animate
            attributeName="opacity"
            values="0.6;0.2;0.6"
            dur="2.9s"
            repeatCount="indefinite"
          />
        </circle>

        {/* Subtle grid pattern overlay */}
        <pattern
          id="grid"
          width="80"
          height="80"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 80 0 L 0 0 0 80"
            fill="none"
            stroke="rgba(255,255,255,0.02)"
            strokeWidth="1"
          />
        </pattern>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Gradient overlay - Reduced opacity for more visible orbs */}
      <div className="absolute inset-0 bg-gradient-to-br from-black via-black to-gray-900 opacity-50" />
    </div>
  );
}
