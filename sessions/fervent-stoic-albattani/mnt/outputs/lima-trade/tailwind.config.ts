import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        gold:   '#FCA311',
        navy:   '#14213D',
        silver: '#E5E5E5',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'ticker':  'ticker 32s linear infinite',
        'marquee': 'marquee 40s linear infinite',
        'fade-up': 'fadeUp 0.6s ease forwards',
        'blink':   'blink 0.85s step-end infinite',
      },
      keyframes: {
        ticker:  { '0%': { transform: 'translateX(0)' }, '100%': { transform: 'translateX(-50%)' } },
        marquee: { '0%': { transform: 'translateX(0)' }, '100%': { transform: 'translateX(-50%)' } },
        fadeUp:  { from: { opacity: '0', transform: 'translateY(20px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        blink:   { '0%,100%': { opacity: '1' }, '50%': { opacity: '0' } },
      },
    },
  },
  plugins: [],
}

export default config
