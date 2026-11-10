// Next.js uses its own built-in PostCSS set when this file is absent, and that set
// does not include Tailwind v4, so `globals.css` would reach the browser unparsed.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
