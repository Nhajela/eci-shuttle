import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Vehicle } from "@/db/types";
import { VehicleCard } from "./VehicleCard";
import { VehicleForm } from "./VehicleForm";

const vehicle = (o: Partial<Vehicle> = {}) =>
  ({ id: "v1", version: 1, name: "Van 1", plate: null, colour: null, capacity: null, active: true, ...o }) as Vehicle;
const action = async () => ({ ok: true, message: null });

describe("VehicleCard", () => {
  it("gives every collapsible a visible chevron and a 44px summary", () => {
    const html = renderToStaticMarkup(
      createElement(VehicleCard, { vehicle: vehicle(), phoneLabel: null, service: null, trips: [], w: "live", action }),
    );
    const summaries = html.match(/<summary[^>]*>.*?<\/summary>/g) ?? [];
    expect(summaries).toHaveLength(2);
    for (const s of summaries) {
      expect(s).toContain("min-h-11");
      expect(s).toMatch(/<svg[^>]*group-open:rotate-90/);
    }
  });
});

describe("VehicleForm colour", () => {
  const swatch = (html: string) => html.match(/<input[^>]*type="color"[^>]*>/)?.[0] ?? "";
  const noColour = (html: string) => html.match(/<input[^>]*name="noColour"[^>]*>/)?.[0] ?? "";

  it("shows a neutral swatch with 'No colour' ticked when the vehicle has none", () => {
    const html = renderToStaticMarkup(createElement(VehicleForm, { w: "live", action, vehicle: vehicle() }));
    expect(noColour(html)).toContain("checked");
    expect(swatch(html)).toContain("opacity-40");
  });

  it("shows the real swatch, unticked, when the vehicle has a colour", () => {
    const html = renderToStaticMarkup(
      createElement(VehicleForm, { w: "live", action, vehicle: vehicle({ colour: "#ff0000" }) }),
    );
    expect(noColour(html)).not.toContain("checked");
    expect(swatch(html)).toContain('value="#ff0000"');
    expect(swatch(html)).not.toContain("opacity-40");
  });
});
