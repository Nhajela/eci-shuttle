import type { PublicStatus } from "@eci-shuttle/shared";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusView } from "./status-view";

const notice = (id: string, text: string) => ({ id, text, severity: "info" as const, pinned: false, endsAt: null });

const status: PublicStatus = {
  workspace: { slug: "test", name: "Edge City", isLive: false },
  generatedAt: "2026-10-12T04:00:00.000Z",
  notices: [notice("n1", "Welcome to Goa")],
  spots: [
    {
      spotId: "riva",
      name: "Riva Resort",
      shortName: "Riva",
      notices: [notice("n2", "Pickup at the side gate")],
      answers: [
        {
          serviceId: "s1",
          serviceName: "To Circle",
          colour: "#286c71",
          kind: "live",
          minutes: 6,
          rangeLo: 5,
          rangeHi: 9,
          approx: false,
          nextAt: null,
          nextAtLabel: null,
          phaseText: "leaving Circle now",
          lastSeenS: 12,
          vehicleName: "Van 1",
          notices: [],
        },
      ],
      schedule: {
        notices: [notice("n3", "Extra runs tonight")],
        rows: [
          {
            serviceId: "s1",
            serviceName: "To Circle",
            at: "2026-10-12T03:40:00Z",
            label: "09:10",
            past: true,
            next: false,
          },
          {
            serviceId: "s1",
            serviceName: "To Circle",
            at: "2026-10-12T04:10:00Z",
            label: "09:40",
            past: false,
            next: true,
          },
        ],
        loops: [],
      },
    },
    {
      spotId: "circle",
      name: "The Circle",
      shortName: "Circle",
      notices: [notice("n4", "Circle only notice")],
      answers: [],
      schedule: { notices: [], rows: [], loops: [] },
    },
  ],
};

const render = (initialSpotId: string | null) =>
  renderToString(createElement(StatusView, { initial: status, slug: "test", initialSpotId }));

describe("StatusView (server render)", () => {
  it("renders the first answer, notices and schedule for the chosen spot", () => {
    const html = render("riva");
    for (const text of ["Where are you?", "Shuttle will be here in", "6 min", "5–9", "leaving Circle now", "09:40"])
      expect(html).toContain(text);
    for (const text of ["Welcome to Goa", "Pickup at the side gate", "Extra runs tonight", "TEST"])
      expect(html).toContain(text);
    expect(html).not.toContain("Circle only notice");
    expect(html.toLowerCase()).not.toMatch(/\blate\b|behind/);
  });

  it("spot notices follow the chosen spot", () => {
    const html = render("circle");
    expect(html).toContain("Circle only notice");
    expect(html).not.toContain("Pickup at the side gate");
  });

  it("the info board shows after the workspace notices, before 'Where are you?', even with no spots", () => {
    const info = createElement("p", null, "Nanu pickup 08:00");
    const html = renderToString(
      createElement(StatusView, { initial: status, slug: "test", initialSpotId: "riva", info }),
    );
    const at = html.indexOf("Nanu pickup 08:00");
    expect(at).toBeGreaterThan(html.indexOf("Welcome to Goa"));
    expect(at).toBeLessThan(html.indexOf("Where are you?"));
    const empty = renderToString(
      createElement(StatusView, { initial: { ...status, spots: [] }, slug: null, initialSpotId: null, info }),
    );
    expect(empty).toContain("Nanu pickup 08:00");
  });

  it("a long timetable shows the last departure and the next five, with buttons for the rest", () => {
    const hhmm = (i: number) =>
      `${String(11 + Math.floor(i / 3)).padStart(2, "0")}:${String((i % 3) * 20).padStart(2, "0")}`;
    const rows = Array.from({ length: 24 }, (_, i) => ({
      serviceId: "s1",
      serviceName: "To Circle",
      at: `2026-10-12T${String(5 + Math.floor(i / 3)).padStart(2, "0")}:${String(30 + (i % 3) * 20 - (i % 3 === 2 ? 60 : 0)).padStart(2, "0")}:00Z`,
      label: hhmm(i),
      past: i < 6,
      next: i === 6,
    }));
    const spots = status.spots.map((s) => (s.spotId === "riva" ? { ...s, schedule: { ...s.schedule, rows } } : s));
    const html = renderToString(
      createElement(StatusView, { initial: { ...status, spots }, slug: "test", initialSpotId: "riva" }),
    );
    for (const t of ["12:40", "13:00", "14:20"]) expect(html).toContain(`>${t}<`);
    for (const t of ["11:00", "12:20", "14:40", "18:40"]) expect(html).not.toContain(`>${t}<`);
    expect(html).toMatch(/Show 5 earlier/);
    expect(html).toMatch(/Show 13 later/);
  });

  it("no spots: says so plainly", () => {
    const html = renderToString(
      createElement(StatusView, { initial: { ...status, spots: [] }, slug: null, initialSpotId: null }),
    );
    expect(html).toContain("No public shuttles are running today.");
  });
});
