import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#132238",
        panel: {
          50: "#f4f8fb",
          100: "#e9f1f7",
          500: "#2878b5",
          600: "#17689f",
          700: "#135681",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,.04), 0 12px 30px rgba(15,23,42,.06)",
      },
    },
  },
  plugins: [],
} satisfies Config;
