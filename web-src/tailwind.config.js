/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: '#1f6fd0',
        'brand-light': '#46a7e6',
        'brand-dark': '#1a4f96',
        navy: '#16315f',
        ink: '#1f2d4d',
        app: '#f4f7fc',
        surface: '#ffffff',
        line: '#e3e8f1',
        muted: '#64748b',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(22,49,95,0.06), 0 1px 3px rgba(22,49,95,0.04)',
        cardhover: '0 6px 18px rgba(22,49,95,0.10)',
      },
      backgroundImage: {
        brand: 'linear-gradient(120deg,#46a7e6 0%,#1f6fd0 55%,#1a4f96 100%)',
      },
    },
  },
  plugins: [],
};
