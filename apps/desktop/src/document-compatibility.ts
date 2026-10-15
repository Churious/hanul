import type {
  CompatibilityIssue,
  CompatibilityStructure,
  DocumentCompatibilityReport,
  DocumentExportFormat,
} from "./document-engine";

export interface CompatibilityTextBoxFacts {
  shapeType: "rectangle" | "ellipse" | "other";
  paragraphCount: number;
  hasNestedContent: boolean;
  hasUnsupportedShapeProperties: boolean;
}

export interface CompatibilityFacts {
  structure: CompatibilityStructure;
  textBoxes: CompatibilityTextBoxFacts[];
  hasFields: boolean;
  hasRangeTags: boolean;
  forcedIssue?: CompatibilityIssue;
}

function issue(code: string, feature: CompatibilityIssue["feature"], message: string): CompatibilityIssue {
  return { code, feature, message };
}

/**
 * Applies Hanul's structural export policy. The content-loss report from the
 * serializer remains a separate check; `supported` means only that this
 * document topology is eligible for the selected format.
 */
export function evaluateDocumentCompatibility(
  format: DocumentExportFormat,
  facts: CompatibilityFacts,
): DocumentCompatibilityReport {
  const structure = facts.structure;
  const textBoxCount = structure.objectCounts.textBox;
  const totalObjectCount = Object.values(structure.objectCounts).reduce((total, count) => total + count, 0);
  let blocker: CompatibilityIssue | undefined = facts.forcedIssue;

  if (!blocker && format === "hwp" && textBoxCount > 0) {
    if (textBoxCount > 1) {
      blocker = issue(
        "hwp.textbox.count",
        "textBox",
        "여러 글상자가 포함된 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
      );
    } else if (structure.sectionCount !== 1) {
      blocker = issue(
        "hwp.textbox.multiple_sections",
        "structure",
        "여러 구역이 포함된 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
      );
    } else if (facts.hasFields || facts.hasRangeTags) {
      blocker = issue(
        "hwp.textbox.fields_or_ranges",
        "textBox",
        "필드 또는 범위 태그가 포함된 글상자 HWP는 데이터 보존을 확인하지 못해 저장을 차단했습니다.",
      );
    } else {
      const textBox = facts.textBoxes[0];
      if (!textBox || textBox.shapeType !== "rectangle" || textBox.hasUnsupportedShapeProperties) {
        blocker = issue(
          "hwp.textbox.unsupported_shape",
          "textBox",
          "단순한 사각형이 아닌 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        );
      } else if (textBox.paragraphCount !== 1) {
        blocker = issue(
          "hwp.textbox.paragraph_count",
          "textBox",
          "여러 문단 또는 비어 있는 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        );
      } else if (textBox.hasNestedContent) {
        blocker = issue(
          "hwp.textbox.nested_content",
          "textBox",
          "표·개체·필드 등 내부 구조가 포함된 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        );
      } else if (structure.tableCount > 0 || totalObjectCount !== 1 || structure.unsupportedControlCount > 0) {
        blocker = issue(
          "hwp.textbox.mixed_content",
          "textBox",
          "표·그림·다른 개체와 글상자가 함께 있는 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        );
      }
    }
  }

  return {
    schemaVersion: 1,
    format,
    supported: blocker === undefined,
    structure,
    issues: blocker ? [blocker] : [],
  };
}

export function emptyCompatibilityObjectCounts() {
  return { picture: 0, rectangle: 0, ellipse: 0, textBox: 0 };
}
