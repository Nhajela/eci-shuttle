/** "Built in the open" card at the bottom of the public page, linking to the GitHub repo. */
export const REPO_URL = "https://github.com/Nhajela/eci-shuttle";

export function OpenSourceCard() {
  return (
    <section aria-labelledby="oss-card" className="frosted flex flex-col gap-3 rounded-card p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-3xl leading-none">
          🛠️
        </span>
        <div className="flex flex-col gap-1">
          <h2 id="oss-card" className="font-heading text-lg font-bold text-ink">
            Built in the open
          </h2>
          <p className="text-[15px] text-ink-soft">
            This tracker, its Telegram bot and the driver app are open source. Take a look, fork it for your own event,
            or help us make it better.
          </p>
        </div>
      </div>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-ink/30 px-5 text-base font-medium text-ink hover:bg-ink/5"
      >
        <span aria-hidden>⭐</span> ECI Shuttle on GitHub
      </a>
    </section>
  );
}
