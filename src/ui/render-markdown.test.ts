// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render-markdown";

describe("renderMarkdown", () => {
  it("retains Markdown structure while removing executable HTML and URLs", () => {
    const rendered = renderMarkdown(`
# Safe heading

<script>globalThis.compromised = true</script>
<img src="safe.png" onerror="globalThis.compromised = true">
<a href="javascript:alert(1)" onclick="alert(2)">unsafe HTML link</a>
[unsafe Markdown link](javascript:alert(3))
`);
    const container = document.createElement("div");
    container.innerHTML = rendered;

    expect(container.querySelector("h1")?.textContent).toBe("Safe heading");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("unsafe Markdown link");

    for (const element of container.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        const attributeName = attribute.name.toLowerCase();
        expect(attributeName.startsWith("on")).toBe(false);
        if (attributeName === "href" || attributeName === "src") {
          expect(
            attribute.value.trim().toLowerCase().startsWith("javascript:"),
          ).toBe(false);
        }
      }
    }
  });
});
