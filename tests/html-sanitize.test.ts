import { describe, it, expect } from "vitest";
import { sanitizeEmailHtml } from "../src/lib/html-sanitize.js";

describe("sanitizeEmailHtml", () => {
  it("removes <script> blocks entirely", () => {
    const result = sanitizeEmailHtml('<p>hi</p><script>alert(document.cookie)</script><p>bye</p>');
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert(document.cookie)");
    expect(result).toContain("<p>hi</p>");
    expect(result).toContain("<p>bye</p>");
  });

  it("removes inline event handler attributes", () => {
    const result = sanitizeEmailHtml('<img src="x.png" onerror="alert(1)">');
    expect(result).not.toContain("onerror");
  });

  it("removes single-quoted inline event handlers", () => {
    const result = sanitizeEmailHtml("<div onclick='doEvil()'>click me</div>");
    expect(result).not.toContain("onclick");
  });

  it("neutralizes javascript: URLs in href", () => {
    const result = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain("javascript:");
    expect(result).toContain("about:blank");
  });

  it("neutralizes data:text/html URLs", () => {
    const result = sanitizeEmailHtml('<iframe src="data:text/html,<script>alert(1)</script>"></iframe>');
    expect(result).not.toContain("data:text/html");
  });

  it("removes meta-refresh redirects", () => {
    const result = sanitizeEmailHtml('<meta http-equiv="refresh" content="0;url=https://evil.example">');
    expect(result).not.toContain("refresh");
  });

  it("removes <base> tags", () => {
    const result = sanitizeEmailHtml('<base href="https://evil.example/"><p>hi</p>');
    expect(result).not.toContain("<base");
  });

  it("leaves ordinary formatting HTML untouched", () => {
    const html = "<p>Hello <b>world</b>, visit <a href=\"https://example.com\">our site</a>.</p>";
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it("removes style blocks containing javascript: or expression()", () => {
    const result = sanitizeEmailHtml("<style>body { background: url('javascript:alert(1)') }</style>");
    expect(result).not.toContain("javascript:");
  });

  it("preserves benign style blocks", () => {
    const html = "<style>body { color: red; }</style><p>hi</p>";
    expect(sanitizeEmailHtml(html)).toBe(html);
  });
});
