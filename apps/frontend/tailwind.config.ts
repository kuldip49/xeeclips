import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
import plugin from "tailwindcss/plugin";

/** A design token from globals.css that still accepts Tailwind's opacity modifier. */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;
/** Brand/status colour with its text-on-dark tone and the text colour that sits on a solid fill. */
const tone = (name: string) => ({
  DEFAULT: token(name),
  soft: token(`${name}-soft`),
  foreground: token(`${name}-foreground`)
});

const config: Config = {
  darkMode: ["class"],
  // Touch screens have no hover: a hover style must never be the only state a tap leaves behind.
  future: { hoverOnlyWhenSupported: true },
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: token("background"),
        sunken: token("sunken"),
        stage: token("stage"),
        surface: token("surface"),
        elevated: token("elevated"),
        border: { DEFAULT: token("border"), strong: token("border-strong") },
        input: token("border"),
        ring: token("ring"),
        foreground: token("foreground"),
        soft: token("soft"),
        faint: token("faint"),
        muted: { DEFAULT: token("elevated"), foreground: token("muted-foreground") },
        card: { DEFAULT: token("surface"), foreground: token("foreground") },
        primary: { ...tone("primary"), hover: token("primary-hover") },
        secondary: tone("secondary"),
        accent: tone("accent"),
        success: tone("success"),
        warning: tone("warning"),
        danger: tone("danger"),
        destructive: tone("danger"),
        track: { video: token("track-video"), text: token("track-text"), caption: token("track-caption"),
          image: token("track-image"), audio: token("track-audio") },
        // Neutral washes over any surface: hovers, quiet rows, active segments.
        tint: {
          subtle: "rgb(255 255 255 / .03)",
          DEFAULT: "rgb(255 255 255 / .05)",
          strong: "rgb(255 255 255 / .09)",
          active: "rgb(255 255 255 / .15)"
        },
        // Recessed wells (segmented-control tracks, logs) and modal backdrops.
        inset: "rgb(0 0 0 / .25)",
        scrim: "rgb(3 5 10 / .72)"
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"]
      },
      boxShadow: {
        glow: "0 8px 24px -6px rgb(var(--primary) / .45)",
        card: "0 1px 0 rgb(255 255 255 / .03) inset, 0 16px 40px -12px rgb(0 0 0 / .5)",
        sheet: "0 -12px 32px rgb(0 0 0 / .45)"
      },
      backgroundImage: {
        "brand-progress": "linear-gradient(90deg, rgb(var(--primary)), rgb(var(--secondary)))",
        "brand-glow": "radial-gradient(60% 50% at 50% 0%, rgb(var(--primary) / .16), transparent 70%), radial-gradient(40% 35% at 85% 10%, rgb(var(--accent) / .07), transparent 70%)"
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)"
      }
    }
  },
  plugins: [animate, plugin(({ addVariant }) => {
    // Touch-first sizing (bigger hit areas, handles) without changing mouse layouts.
    addVariant("coarse", "@media (pointer: coarse)");
    addVariant("fine", "@media (pointer: fine)");
  })]
};

export default config;
