/**
 * The workspace's info board on the attendee page: markdown set by ops in admin → Notices, shown until changed
 * (unlike notices, it has no times). Raw HTML in the markdown is never rendered; unsafe link schemes are dropped.
 */
import Markdown, { type Components } from "react-markdown";

const COMPONENTS: Components = {
  h1: ({ children }) => <h2 className="font-heading text-lg font-semibold text-ink">{children}</h2>,
  h2: ({ children }) => <h2 className="font-heading text-base font-semibold text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="font-heading text-[15px] font-semibold text-ink">{children}</h3>,
  p: ({ children }) => <p>{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-teal underline">
      {children}
    </a>
  ),
  img: () => null,
  hr: () => <hr className="border-line-soft" />,
};

export function InfoBoard({ md }: { md: string | null }) {
  if (!md?.trim()) return null;
  return (
    <section
      aria-label="Info"
      className="flex flex-col gap-2 rounded-card border border-line bg-sand px-4 py-3 text-[15px] leading-snug text-ink-soft"
    >
      <Markdown components={COMPONENTS} skipHtml>
        {md}
      </Markdown>
    </section>
  );
}
