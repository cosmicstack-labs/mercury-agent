/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Mercury brand cyan
        mercury: {
          50: "hsl(192, 80%, 98%)",
          100: "hsl(192, 70%, 95%)",
          200: "hsl(192, 65%, 90%)",
          300: "hsl(192, 60%, 84%)",
          400: "hsl(192, 55%, 76%)",
          500: "#00d4ff",
          600: "hsl(192, 80%, 45%)",
          700: "hsl(192, 70%, 35%)",
          800: "hsl(192, 60%, 25%)",
          900: "hsl(192, 50%, 15%)",
          950: "hsl(192, 40%, 7%)",
        },
        // Purple accent (gradient partner)
        accent: {
          50: "hsl(263, 90%, 98%)",
          100: "hsl(263, 80%, 94%)",
          200: "hsl(263, 70%, 88%)",
          300: "hsl(263, 65%, 80%)",
          400: "#a78bfa",
          500: "hsl(263, 85%, 55%)",
          600: "hsl(263, 80%, 45%)",
          700: "hsl(263, 70%, 35%)",
          800: "hsl(263, 60%, 25%)",
          900: "hsl(263, 50%, 15%)",
        },
        // Semantic design tokens
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: [
          "Geist",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "sans-serif",
        ],
        mono: [
          "Geist Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-in-left": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "glow-breathe": {
          "0%, 100%": { boxShadow: "0 0 8px rgba(0, 212, 255, 0.15)" },
          "50%": { boxShadow: "0 0 20px rgba(0, 212, 255, 0.3)" },
        },
        "cursor-blink": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "slide-in-right": "slide-in-right 0.25s ease-out",
        "slide-in-left": "slide-in-left 0.25s ease-out",
        "scale-in": "scale-in 0.15s ease-out",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow-breathe": "glow-breathe 3s ease-in-out infinite",
        "cursor-blink": "cursor-blink 1s step-end infinite",
      },
    },
  },
  plugins: [],
};
