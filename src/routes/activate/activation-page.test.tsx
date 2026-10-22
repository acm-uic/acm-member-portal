import { jsx } from "@builder.io/qwik/jsx-runtime";
import { renderToString } from "@builder.io/qwik/server";
import { expect, it } from "vitest";
import ActivationPage from "./index";

it("renders a POST fallback so activation passwords cannot become URL query parameters", async () => {
  const result = await renderToString(
    [jsx("head", {}), jsx("body", { children: jsx(ActivationPage, {}) })],
    {
      symbolMapper: (symbol) => [symbol, "/test-render.js"],
    },
  );
  const form = result.html.match(/<form\b[^>]*>/)?.[0];
  expect(form).toBeDefined();
  expect(form).toContain('method="post"');
  expect(form).toContain('action="/api/activate/"');
  expect(result.html).toContain('name="currentPassword"');
  expect(result.html).toContain('name="newPassword"');
});
