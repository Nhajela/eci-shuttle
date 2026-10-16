/**
 * The painted scene behind the attendee page. Parallax layers (sky, far, mid, road) drift very slowly when
 * present, with the painted van parked in the hero on phones; else one still scene; else the hero (art-directed
 * wide / tall); else a soft Goa-sky gradient. Everything fades into paper towards the bottom so the cards in
 * front stay legible. `prefers-reduced-motion` stops the drift (globals.css).
 */
import type { PublicArt } from "./art";

/** the stack is one 16:9 painting: every layer covers the box the same way, so they stay aligned */
const LAYER = "absolute inset-0 size-full object-cover object-[50%_100%]";

export function Scene({ art }: { art: PublicArt }) {
  const van = art.sceneLayers.find((f) => /\/van\.(webp|png)$/i.test(f)) ?? null;
  const stack = art.sceneLayers.filter((f) => f !== van);
  const still = art.sceneWide ?? art.heroWide;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-sand">
      {stack.length > 0 ? (
        stack.map((src, i) => (
          // biome-ignore lint/performance/noImgElement: static webp straight from /public, art-directed by CSS
          <img
            key={src}
            src={src}
            alt=""
            decoding="async"
            fetchPriority={i === 0 ? "high" : "low"}
            className={`scene-layer ${LAYER}`}
            style={{ animationDuration: `${70 - i * 14}s`, animationDelay: `${-i * 7}s` }}
          />
        ))
      ) : still ? (
        <picture>
          {art.heroTall && !art.sceneWide && <source media="(max-width: 640px)" srcSet={art.heroTall} />}
          <img src={still} alt="" fetchPriority="high" className={LAYER} />
        </picture>
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(120%_70%_at_50%_-10%,var(--mint)_0%,var(--teal-tint)_45%,transparent_80%)]" />
      )}
      {van && (
        // biome-ignore lint/performance/noImgElement: static webp straight from /public
        <img
          src={van}
          alt=""
          decoding="async"
          className="scene-van absolute top-[7vh] right-[3%] w-[56vw] max-w-[340px] drop-shadow-[0_18px_24px_rgba(20,27,52,0.25)] lg:hidden"
        />
      )}
      {/* sun glow + fade to paper */}
      <div className="absolute inset-0 bg-[radial-gradient(60%_35%_at_80%_8%,color-mix(in_oklab,var(--marigold)_30%,transparent)_0%,transparent_70%)]" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[color-mix(in_oklab,var(--paper)_55%,transparent)] via-50% to-paper to-92%" />
    </div>
  );
}
