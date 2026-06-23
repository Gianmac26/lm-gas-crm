/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        navy: {
          50:  '#eff6ff',
          100: '#dbeafe',
          500: '#1e40af',
          600: '#1e3a8a',
          700: '#1e2d6b',
          800: '#172554',
          900: '#0f172a',
        },
        brand: {
          orange: '#f97316',
          navy:   '#1e3a8a',
        },
      },
    },
  },
  plugins: [],
};
