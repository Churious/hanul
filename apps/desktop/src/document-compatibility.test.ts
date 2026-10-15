import { describe, expect, it } from "vitest";
import {
  canSaveWithCompatibility,
  compatibilityIssueMessage,
  evaluateDocumentCompatibility,
  withSerializerLosses,
  type CompatibilityFacts,
} from "./document-compatibility";
import type { ContentLossReport } from "./document-engine";

function facts(overrides: Partial<CompatibilityFacts["structure"]> = {}): CompatibilityFacts {
  return {
    structure: {
      sectionCount: 1,
      paragraphCount: 1,
      tableCount: 0,
      objectCounts: { picture: 0, rectangle: 0, ellipse: 0, textBox: 0 },
      textBoxParagraphCounts: [],
      textBoxShapeTypes: [],
      textBoxUnsupportedProperties: [],
      textBoxHasNestedContent: [],
      hasFields: false,
      hasRangeTags: false,
      unsupportedControlCount: 0,
      unknownControlCount: 0,
      ...overrides,
    },
    textBoxes: [],
    hasFields: false,
    hasRangeTags: false,
  };
}

function textboxFacts(paragraphCount = 1) {
  return {
    ...facts({
      objectCounts: { picture: 0, rectangle: 0, ellipse: 0, textBox: 1 },
      textBoxParagraphCounts: [paragraphCount],
      textBoxShapeTypes: ["rectangle"],
      textBoxUnsupportedProperties: [false],
      textBoxHasNestedContent: [false],
    }),
    textBoxes: [{
      shapeType: "rectangle" as const,
      paragraphCount,
      hasNestedContent: false,
      hasUnsupportedShapeProperties: false,
    }],
  };
}

describe("document compatibility decision policy", () => {
  it.each(["hwp", "hwpx"] as const)("allows the plain internal round-trip profile for %s", (format) => {
    const report = evaluateDocumentCompatibility(format, facts());
    expect(report).toMatchObject({
      status: "SUPPORTED",
      supported: true,
      validationScope: "internal-structure",
      issues: [],
    });
    expect(canSaveWithCompatibility(report, false)).toBe(true);
  });

  it("reports the independent Hanul textbox profile separately from the RHWP session", () => {
    const independent = evaluateDocumentCompatibility("hwp", textboxFacts(), "hanul-text");
    const compatibility = evaluateDocumentCompatibility("hwp", textboxFacts(), "rhwp-compat");
    expect(independent).toMatchObject({ engine: "hanul-text", status: "SUPPORTED" });
    expect(compatibility).toMatchObject({
      engine: "rhwp-compat",
      status: "UNSUPPORTED",
      issues: [{
        code: "hwp.textbox.rhwp_session",
        affectedElements: [{ kind: "textBox", count: 1 }],
      }],
    });
  });

  it("blocks unknown multi-section and control structures in both formats", () => {
    for (const format of ["hwp", "hwpx"] as const) {
      expect(evaluateDocumentCompatibility(format, facts({ sectionCount: 2 }))).toMatchObject({
        status: "UNKNOWN",
        supported: false,
        issues: [{ code: "document.multiple_sections", affectedElements: [{ kind: "section", count: 2 }] }],
      });
      expect(evaluateDocumentCompatibility(format, facts({ unknownControlCount: 2 }))).toMatchObject({
        status: "UNKNOWN",
        issues: [{ code: "document.unknown_control", affectedElements: [{ kind: "unknownControl", count: 2 }] }],
      });
      expect(evaluateDocumentCompatibility(format, facts({ hasRangeTags: true }))).toMatchObject({
        status: "UNKNOWN",
        issues: [{ code: "document.range_tags.unverified", affectedElements: [{ kind: "rangeTag", count: 1 }] }],
      });
    }
  });

  it("applies the same conservative profile to the baseline HWP and HWPX structures", () => {
    const singleTextbox = textboxFacts();
    const multiParagraphTextbox = textboxFacts(2);
    const mixed = {
      ...singleTextbox,
      structure: {
        ...singleTextbox.structure,
        tableCount: 1,
        objectCounts: { picture: 1, rectangle: 0, ellipse: 0, textBox: 1 },
      },
    };
    const profiles: Array<{
      label: string;
      facts: CompatibilityFacts;
      hwp: "SUPPORTED" | "UNSUPPORTED" | "LOSSY" | "UNKNOWN";
      hwpx: "SUPPORTED" | "UNSUPPORTED" | "LOSSY" | "UNKNOWN";
    }> = [
      { label: "plain text and formatting", facts: facts({ paragraphCount: 2 }), hwp: "SUPPORTED", hwpx: "SUPPORTED" },
      { label: "table including merged-cell profile", facts: facts({ tableCount: 1 }), hwp: "SUPPORTED", hwpx: "SUPPORTED" },
      { label: "picture", facts: facts({ objectCounts: { picture: 1, rectangle: 0, ellipse: 0, textBox: 0 } }), hwp: "SUPPORTED", hwpx: "SUPPORTED" },
      { label: "rectangle", facts: facts({ objectCounts: { picture: 0, rectangle: 1, ellipse: 0, textBox: 0 } }), hwp: "SUPPORTED", hwpx: "SUPPORTED" },
      { label: "ellipse", facts: facts({ objectCounts: { picture: 0, rectangle: 0, ellipse: 1, textBox: 0 } }), hwp: "SUPPORTED", hwpx: "SUPPORTED" },
      { label: "single paragraph textbox", facts: singleTextbox, hwp: "SUPPORTED", hwpx: "SUPPORTED" },
      { label: "multiple paragraph textbox", facts: multiParagraphTextbox, hwp: "UNSUPPORTED", hwpx: "UNKNOWN" },
      { label: "table, picture and textbox mixture", facts: mixed, hwp: "UNSUPPORTED", hwpx: "SUPPORTED" },
      { label: "header/footer field profile before serializer report", facts: facts({ hasFields: true }), hwp: "SUPPORTED", hwpx: "SUPPORTED" },
      { label: "multiple sections", facts: facts({ sectionCount: 2 }), hwp: "UNKNOWN", hwpx: "UNKNOWN" },
    ];

    for (const profile of profiles) {
      expect(evaluateDocumentCompatibility("hwp", profile.facts).status, profile.label).toBe(profile.hwp);
      expect(evaluateDocumentCompatibility("hwpx", profile.facts).status, profile.label).toBe(profile.hwpx);
    }
  });

  it("keeps verified mixed-object round trips format-specific", () => {
    const mixed = {
      ...textboxFacts(),
      structure: {
        ...textboxFacts().structure,
        tableCount: 1,
        objectCounts: { picture: 1, rectangle: 1, ellipse: 0, textBox: 1 },
      },
    };
    expect(evaluateDocumentCompatibility("hwp", mixed, "hanul-text")).toMatchObject({
      status: "UNSUPPORTED",
      issues: [{
        code: "hwp.textbox.mixed_content",
        affectedElements: [
          { kind: "textBox", count: 1 },
          { kind: "table", count: 1 },
          { kind: "picture", count: 1 },
          { kind: "rectangle", count: 1 },
        ],
      }],
    });
    expect(evaluateDocumentCompatibility("hwpx", mixed, "hanul-text")).toMatchObject({
      status: "SUPPORTED",
      supported: true,
    });
  });

  it("requires a confirmation for known serializer loss and never converts unknown loss to a warning", () => {
    const base = evaluateDocumentCompatibility("hwpx", facts());
    const losses: ContentLossReport = {
      schemaVersion: 1,
      outputFormat: "hwpx",
      count: 1,
      losses: [{ code: "unsupported-font-effect", subject: "characterFormat", message: "장식 효과" }],
    };
    const lossy = withSerializerLosses(base, losses);
    expect(lossy).toMatchObject({
      status: "LOSSY",
      supported: true,
      issues: [{ code: "serializer.known_loss", affectedElements: [{ kind: "characterFormat", count: 1 }] }],
    });
    expect(canSaveWithCompatibility(lossy, false)).toBe(false);
    expect(canSaveWithCompatibility(lossy, true)).toBe(true);
    expect(compatibilityIssueMessage(lossy, "fallback")).toContain("characterFormat 1개");

    const countOnlyLoss = withSerializerLosses(base, { ...losses, losses: [] });
    expect(countOnlyLoss.issues[0]?.affectedElements).toEqual([{ kind: "serializerLoss", count: 1 }]);

    const unknown = evaluateDocumentCompatibility("hwpx", facts({ unknownControlCount: 1 }));
    expect(canSaveWithCompatibility(withSerializerLosses(unknown, losses), true)).toBe(false);
  });
});
