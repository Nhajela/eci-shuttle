import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmAsk, ConfirmButton } from "./confirm-button";

const noop = () => {};

describe("ConfirmButton", () => {
  it("first shows only the action, not the question", () => {
    const html = renderToString(
      createElement(ConfirmButton, { label: "Kill tracking", question: "Kill Van 1?", onConfirm: noop }),
    );
    expect(html).toContain("Kill tracking");
    expect(html).not.toContain("Kill Van 1?");
  });

  it("the second step asks, explains, shows extra fields, and offers No and the confirm label", () => {
    const html = renderToString(
      createElement(
        ConfirmAsk,
        {
          question: "Move Van 1?",
          description: "Its vehicle is cleared.",
          confirmLabel: "Move",
          onNo: noop,
          onYes: noop,
        },
        createElement("select", { "aria-label": "To" }),
      ),
    );
    expect(html).toContain("Move Van 1?");
    expect(html).toContain("Its vehicle is cleared.");
    expect(html).toContain('aria-label="To"');
    expect(html).toContain(">No<");
    expect(html).toContain(">Move<");
    expect(html).toContain("<fieldset");
  });

  it("the confirm label defaults to Yes", () => {
    const html = renderToString(createElement(ConfirmAsk, { question: "Sure?", onNo: noop, onYes: noop }));
    expect(html).toContain(">Yes<");
  });
});
