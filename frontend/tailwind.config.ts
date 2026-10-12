import type { Config } from 'tailwindcss'

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), panel: v('panel'), ink: v('ink'), mute: v('mute'), line: v('line'),
        heal: v('heal'), stat: v('stat'),
        ok: v('ok'), warn: v('warn'), bad: v('bad'),
      },
      fontSize: { base: ['14px', '20px'] },
    },
  },
  plugins: [],
} satisfies Config
