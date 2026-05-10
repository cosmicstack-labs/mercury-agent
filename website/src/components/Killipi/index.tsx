import React, { useEffect, useRef, useState, useCallback } from 'react';
import './styles.css';

type Expression = 'idle' | 'happy' | 'surprised' | 'wink' | 'sleepy';

export default function Killipi(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 });
  const [expression, setExpression] = useState<Expression>('idle');
  const [isHovered, setIsHovered] = useState(false);
  const [clickScale, setClickScale] = useState(1);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setInterval>>(null);
  const [isBlinking, setIsBlinking] = useState(false);

  // Eye tracking — follow the cursor
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxOffset = 6;
    const factor = Math.min(dist / 300, 1);
    setEyeOffset({
      x: (dx / (dist || 1)) * maxOffset * factor,
      y: (dy / (dist || 1)) * maxOffset * factor,
    });

    // Reset idle timer
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (expression === 'sleepy') setExpression('idle');
    idleTimerRef.current = setTimeout(() => {
      setExpression('sleepy');
    }, 8000);
  }, [expression]);

  // Touch support for mobile
  const handleTouchMove = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = touch.clientX - cx;
    const dy = touch.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxOffset = 6;
    const factor = Math.min(dist / 300, 1);
    setEyeOffset({
      x: (dx / (dist || 1)) * maxOffset * factor,
      y: (dy / (dist || 1)) * maxOffset * factor,
    });
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchmove', handleTouchMove);
    };
  }, [handleMouseMove, handleTouchMove]);

  // Blinking
  useEffect(() => {
    blinkTimerRef.current = setInterval(() => {
      if (Math.random() < 0.3) {
        setIsBlinking(true);
        setTimeout(() => setIsBlinking(false), 150);
      }
    }, 2500);
    return () => {
      if (blinkTimerRef.current) clearInterval(blinkTimerRef.current);
    };
  }, []);

  // Idle timer — go sleepy after 8s
  useEffect(() => {
    idleTimerRef.current = setTimeout(() => {
      setExpression('sleepy');
    }, 8000);
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  const handleClick = () => {
    const expressions: Expression[] = ['happy', 'surprised', 'wink'];
    const next = expressions[Math.floor(Math.random() * expressions.length)];
    setExpression(next);
    setClickScale(1.08);
    setTimeout(() => setClickScale(1), 200);
    setTimeout(() => setExpression('idle'), 2000);
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (expression === 'sleepy') setExpression('surprised');
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    setEyeOffset({ x: 0, y: 0 });
  };

  // Render eyes based on expression
  const renderEyes = () => {
    const baseLeftX = 90;
    const baseRightX = 110;
    const baseY = 98;
    const lx = baseLeftX + eyeOffset.x;
    const ly = baseY + eyeOffset.y;
    const rx = baseRightX + eyeOffset.x;
    const ry = baseY + eyeOffset.y;

    if (isBlinking && expression !== 'sleepy' && expression !== 'wink') {
      return (
        <>
          <line x1={lx - 4} y1={ly} x2={lx + 4} y2={ly} stroke="var(--killipi-feature)" strokeWidth="2" strokeLinecap="round" />
          <line x1={rx - 4} y1={ry} x2={rx + 4} y2={ry} stroke="var(--killipi-feature)" strokeWidth="2" strokeLinecap="round" />
        </>
      );
    }

    switch (expression) {
      case 'happy':
        return (
          <>
            {/* Happy arched eyes */}
            <path d={`M${lx - 5},${ly + 1} Q${lx},${ly - 5} ${lx + 5},${ly + 1}`} stroke="var(--killipi-feature)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
            <path d={`M${rx - 5},${ry + 1} Q${rx},${ry - 5} ${rx + 5},${ry + 1}`} stroke="var(--killipi-feature)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          </>
        );
      case 'surprised':
        return (
          <>
            <circle cx={lx} cy={ly} r="5" fill="var(--killipi-feature)" />
            <circle cx={rx} cy={ry} r="5" fill="var(--killipi-feature)" />
            <circle cx={lx + 1.5} cy={ly - 1.5} r="1.5" fill="var(--killipi-bg)" />
            <circle cx={rx + 1.5} cy={ry - 1.5} r="1.5" fill="var(--killipi-bg)" />
          </>
        );
      case 'wink':
        return (
          <>
            <circle cx={lx} cy={ly} r="3.5" fill="var(--killipi-feature)" />
            <path d={`M${rx - 5},${ry} Q${rx},${ry - 5} ${rx + 5},${ry}`} stroke="var(--killipi-feature)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          </>
        );
      case 'sleepy':
        return (
          <>
            <path d={`M${lx - 4},${ly} Q${lx},${ly + 3} ${lx + 4},${ly}`} stroke="var(--killipi-feature)" strokeWidth="2" fill="none" strokeLinecap="round" />
            <path d={`M${rx - 4},${ry} Q${rx},${ry + 3} ${rx + 4},${ry}`} stroke="var(--killipi-feature)" strokeWidth="2" fill="none" strokeLinecap="round" />
          </>
        );
      default: // idle
        return (
          <>
            <circle cx={lx} cy={ly} r="3.5" fill="var(--killipi-feature)" />
            <circle cx={rx} cy={ry} r="3.5" fill="var(--killipi-feature)" />
          </>
        );
    }
  };

  // Render mouth based on expression
  const renderMouth = () => {
    const my = 110 + eyeOffset.y * 0.3;
    const mx = 100 + eyeOffset.x * 0.3;
    switch (expression) {
      case 'happy':
        return <path d={`M${mx - 8},${my} Q${mx},${my + 10} ${mx + 8},${my}`} stroke="var(--killipi-feature)" strokeWidth="2" fill="none" strokeLinecap="round" />;
      case 'surprised':
        return <ellipse cx={mx} cy={my + 3} rx="4" ry="5" stroke="var(--killipi-feature)" strokeWidth="2" fill="none" />;
      case 'wink':
        return <path d={`M${mx - 6},${my + 1} Q${mx},${my + 7} ${mx + 6},${my + 1}`} stroke="var(--killipi-feature)" strokeWidth="2" fill="none" strokeLinecap="round" />;
      case 'sleepy':
        return <path d={`M${mx - 5},${my + 2} L${mx + 5},${my + 2}`} stroke="var(--killipi-feature)" strokeWidth="2" strokeLinecap="round" />;
      default:
        return <path d={`M${mx - 5},${my + 1} Q${mx},${my + 6} ${mx + 5},${my + 1}`} stroke="var(--killipi-feature)" strokeWidth="2" fill="none" strokeLinecap="round" />;
    }
  };

  return (
    <div
      className={`killipi-container ${isHovered ? 'killipi-hovered' : ''}`}
      ref={containerRef}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ transform: `scale(${clickScale})` }}
      role="img"
      aria-label="Killipi — Mercury's mascot. Click to interact!"
    >
      {/* Ambient glow layers */}
      <div className="killipi-glow killipi-glow-1" />
      <div className="killipi-glow killipi-glow-2" />

      {/* Particle ring */}
      <div className="killipi-particles">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="killipi-particle"
            style={{
              '--particle-angle': `${i * 45}deg`,
              '--particle-delay': `${i * 0.4}s`,
            } as React.CSSProperties}
          />
        ))}
      </div>

      <svg
        className="killipi-svg"
        viewBox="60 55 80 100"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id="killipi-shadow">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="rgba(0,212,255,0.3)" />
          </filter>
          <radialGradient id="killipi-face-gradient" cx="50%" cy="40%" r="50%">
            <stop offset="0%" stopColor="var(--killipi-face-highlight)" />
            <stop offset="100%" stopColor="var(--killipi-face-bg)" />
          </radialGradient>
        </defs>

        {/* Ears */}
        <path
          d="M 80 78 Q 76 60 87 72"
          stroke="var(--killipi-stroke)"
          strokeWidth="2"
          fill="var(--killipi-face-bg)"
          strokeLinecap="round"
        />
        <path
          d="M 120 78 Q 124 60 113 72"
          stroke="var(--killipi-stroke)"
          strokeWidth="2"
          fill="var(--killipi-face-bg)"
          strokeLinecap="round"
        />

        {/* Face circle */}
        <circle
          cx="100"
          cy="100"
          r="30"
          fill="url(#killipi-face-gradient)"
          stroke="var(--killipi-stroke)"
          strokeWidth="2"
          className="killipi-outer-ring"
        />

        {/* Eyes */}
        {renderEyes()}

        {/* Mouth */}
        {renderMouth()}

        {/* Mercury symbol stem + cross */}
        <line x1="100" y1="130" x2="100" y2="148" stroke="var(--killipi-stroke)" strokeWidth="2" />
        <line x1="93" y1="140" x2="107" y2="140" stroke="var(--killipi-stroke)" strokeWidth="2" strokeLinecap="round" />
      </svg>

      <div className="killipi-label">
        {expression === 'sleepy' && <span className="killipi-status">zzz...</span>}
        {expression === 'happy' && <span className="killipi-status killipi-status-happy">:D</span>}
        {expression === 'surprised' && <span className="killipi-status killipi-status-surprised">!</span>}
        {expression === 'wink' && <span className="killipi-status killipi-status-wink">;)</span>}
      </div>
    </div>
  );
}
