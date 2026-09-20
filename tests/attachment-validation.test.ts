import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  validateAttachment,
  hasInlineRenderRiskExtension,
} from "../src/lib/attachment-validation.js";

describe("sanitizeFilename", () => {
  it("passes through an ordinary filename unchanged", () => {
    expect(sanitizeFilename("invoice.pdf")).toBe("invoice.pdf");
  });

  it("strips path-traversal components, keeping only the final segment", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("../../../evil.sh")).toBe("evil.sh");
    expect(sanitizeFilename("C:\\Windows\\System32\\evil.exe")).toBe("evil.exe");
  });

  it("strips null bytes and control characters", () => {
    expect(sanitizeFilename("file\x00.pdf.exe")).toBe("file.pdf.exe");
    expect(sanitizeFilename("evil\x1b[31m.txt")).toBe("evil[31m.txt");
  });

  it("falls back to a generic name for empty/null/dot-only input", () => {
    expect(sanitizeFilename(null)).toBe("attachment");
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename("...")).toBe("attachment");
    expect(sanitizeFilename(".")).toBe("attachment");
  });

  it("truncates absurdly long filenames while preserving a short extension", () => {
    const longName = "a".repeat(500) + ".pdf";
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(255);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("strips a leading dot that could resemble a hidden file", () => {
    expect(sanitizeFilename(".bashrc")).toBe("bashrc");
  });
});

describe("hasInlineRenderRiskExtension", () => {
  it("flags HTML/SVG/XML extensions", () => {
    expect(hasInlineRenderRiskExtension("page.html")).toBe(true);
    expect(hasInlineRenderRiskExtension("page.htm")).toBe(true);
    expect(hasInlineRenderRiskExtension("image.svg")).toBe(true);
    expect(hasInlineRenderRiskExtension("data.xml")).toBe(true);
  });

  it("does not flag ordinary document types", () => {
    expect(hasInlineRenderRiskExtension("invoice.pdf")).toBe(false);
    expect(hasInlineRenderRiskExtension("photo.png")).toBe(false);
    expect(hasInlineRenderRiskExtension("archive.zip")).toBe(false);
  });
});

describe("validateAttachment", () => {
  it("accepts a normal attachment within size limits", () => {
    const result = validateAttachment({ filename: "report.pdf", sizeBytes: 1024, maxAttachmentSize: 5_000_000 });
    expect(result.valid).toBe(true);
    expect(result.sanitizedFilename).toBe("report.pdf");
  });

  it("rejects an empty attachment", () => {
    const result = validateAttachment({ filename: "empty.txt", sizeBytes: 0, maxAttachmentSize: 5_000_000 });
    expect(result.valid).toBe(false);
  });

  it("rejects an attachment exceeding the max size", () => {
    const result = validateAttachment({ filename: "huge.zip", sizeBytes: 10_000_000, maxAttachmentSize: 5_000_000 });
    expect(result.valid).toBe(false);
  });

  it("still sanitizes the filename even when rejecting on size", () => {
    // Sanity check that validation and sanitization are independent passes.
    const result = validateAttachment({
      filename: "../../evil.sh",
      sizeBytes: 999_999_999,
      maxAttachmentSize: 5_000_000,
    });
    expect(result.valid).toBe(false);
  });
});
