/** @type {import('tailwindcss').Config} */

// The colour scales point at CSS variables (RGB triplets) defined in
// renderer/css/app.css, so the dark and light themes swap them in one place.
function scale(name, steps) {
  return Object.fromEntries(
    steps.map((step) => [step, `rgb(var(--c-${name}-${step}) / <alpha-value>)`])
  );
}

const NEUTRAL = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const HUE = [300, 400, 500, 600, 700];

module.exports = {
  content: ['./renderer/**/*.html', './renderer/js/**/*.js', './renderer/css/**/*.css'],
  theme: {
    extend: {
      colors: {
        slate: scale('slate', NEUTRAL),
        blue: scale('blue', HUE),
        green: scale('green', HUE),
        red: scale('red', HUE),
        yellow: scale('yellow', HUE),
        purple: scale('purple', HUE),
        ink: 'rgb(var(--c-ink) / <alpha-value>)'
      },
      borderRadius: {
        sm: '2px',
        DEFAULT: '3px',
        md: '3px',
        lg: '3px',
        xl: '3px',
        '2xl': '3px'
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      fontSize: {
        xs: ['11px', '1.5'],
        sm: ['12px', '1.5'],
        base: ['13px', '1.5'],
        lg: ['15px', '1.4'],
        xl: ['17px', '1.3'],
        '2xl': ['20px', '1.3']
      }
    }
  },
  plugins: []
};
