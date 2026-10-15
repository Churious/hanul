import type {
  CompatibilityAffectedElement,
  CompatibilityEngine,
  CompatibilityIssue,
  CompatibilityStructure,
  CompatibilityStatus,
  ContentLossReport,
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

function issue(
  code: string,
  status: Exclude<CompatibilityStatus, "SUPPORTED">,
  feature: CompatibilityIssue["feature"],
  message: string,
  affectedElements: CompatibilityAffectedElement[],
): CompatibilityIssue {
  return { code, status, feature, message, affectedElements };
}

function textBoxElements(count: number): CompatibilityAffectedElement[] {
  return count > 0 ? [{ kind: "textBox", count }] : [];
}

/**
 * Applies Hanul's shared structural export policy. Serializer loss is merged
 * after export, before the user is asked to approve a lossy save.
 */
export function evaluateDocumentCompatibility(
  format: DocumentExportFormat,
  facts: CompatibilityFacts,
  engine: Exclude<CompatibilityEngine, "rhwp-inspector"> = "hanul-text",
): DocumentCompatibilityReport {
  const structure = facts.structure;
  const textBoxCount = structure.objectCounts.textBox;
  const totalObjectCount = Object.values(structure.objectCounts).reduce((total, count) => total + count, 0);
  let finding: CompatibilityIssue | undefined = facts.forcedIssue;

  if (!finding && structure.unknownControlCount > 0) {
    finding = issue(
      "document.unknown_control",
      "UNKNOWN",
      "control",
      "문서에 저장 호환성을 판정하지 못한 컨트롤이 있습니다. 내용을 보존할 수 있는지 확인할 수 없어 저장을 차단했습니다.",
      [{ kind: "unknownControl", count: structure.unknownControlCount }],
    );
  }

  if (!finding && structure.unsupportedControlCount > 0) {
    finding = issue(
      "document.unsupported_control",
      "UNSUPPORTED",
      "control",
      "현재 저장 경로에서 안전하게 기록할 수 없는 문서 컨트롤이 있습니다.",
      [{ kind: "unsupportedControl", count: structure.unsupportedControlCount }],
    );
  }

  if (!finding && structure.sectionCount !== 1) {
    finding = issue(
      "document.multiple_sections",
      "UNKNOWN",
      "section",
      "다중 구역 문서의 저장·재열기 보존을 검증하지 않아 저장을 차단했습니다.",
      [{ kind: "section", count: structure.sectionCount }],
    );
  }

  if (!finding && format === "hwp" && textBoxCount > 0) {
    if (engine === "rhwp-compat") {
      finding = issue(
        "hwp.textbox.rhwp_session",
        "UNSUPPORTED",
        "textBox",
        "RHWP 호환 세션의 글상자 구조는 제품 저장 경로에서 검증되지 않아 HWP 저장을 차단했습니다.",
        textBoxElements(textBoxCount),
      );
    } else if (textBoxCount > 1) {
      finding = issue(
        "hwp.textbox.count",
        "UNSUPPORTED",
        "textBox",
        "여러 글상자가 포함된 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        textBoxElements(textBoxCount),
      );
    } else if (facts.hasFields || facts.hasRangeTags) {
      finding = issue(
        "hwp.textbox.fields_or_ranges",
        "UNSUPPORTED",
        "textBox",
        "필드 또는 범위 태그가 포함된 글상자 HWP는 데이터 보존을 확인하지 못해 저장을 차단했습니다.",
        [...textBoxElements(textBoxCount), ...(facts.hasFields ? [{ kind: "field", count: 1 }] : []), ...(facts.hasRangeTags ? [{ kind: "rangeTag", count: 1 }] : [])],
      );
    } else {
      const textBox = facts.textBoxes[0];
      if (!textBox || textBox.shapeType !== "rectangle" || textBox.hasUnsupportedShapeProperties) {
        finding = issue(
          "hwp.textbox.unsupported_shape",
          "UNSUPPORTED",
          "textBox",
          "단순한 사각형이 아닌 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
          textBoxElements(textBoxCount),
        );
      } else if (textBox.paragraphCount !== 1) {
        finding = issue(
          "hwp.textbox.paragraph_count",
          "UNSUPPORTED",
          "textBox",
          "여러 문단 또는 비어 있는 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
          textBoxElements(textBoxCount),
        );
      } else if (textBox.hasNestedContent) {
        finding = issue(
          "hwp.textbox.nested_content",
          "UNSUPPORTED",
          "textBox",
          "표·개체·필드 등 내부 구조가 포함된 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
          textBoxElements(textBoxCount),
        );
      } else if (structure.tableCount > 0 || totalObjectCount !== 1) {
        finding = issue(
          "hwp.textbox.mixed_content",
          "UNSUPPORTED",
          "textBox",
          "표·그림·다른 개체와 글상자가 함께 있는 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
          [
            ...textBoxElements(textBoxCount),
            ...(structure.tableCount ? [{ kind: "table", count: structure.tableCount }] : []),
            ...Object.entries(structure.objectCounts)
              .filter(([kind, count]) => kind !== "textBox" && count > 0)
              .map(([kind, count]) => ({ kind, count })),
          ],
        );
      }
    }
  }

  if (!finding && format === "hwpx" && textBoxCount > 0) {
    const hasUnverifiedTextBox = textBoxCount > 1 || facts.textBoxes.some((textBox) => textBox.paragraphCount !== 1 || textBox.hasNestedContent);
    if (hasUnverifiedTextBox) {
      finding = issue(
        "hwpx.textbox.unverified_structure",
        "UNKNOWN",
        "textBox",
        "여러 글상자, 여러 문단 또는 중첩 구조가 있는 HWPX 글상자는 저장 왕복 범위를 검증하지 않아 저장을 차단했습니다.",
        textBoxElements(textBoxCount),
      );
    }
  }

  if (!finding && structure.hasRangeTags) {
    finding = issue(
      "document.range_tags.unverified",
      "UNKNOWN",
      "document",
      "범위 태그가 포함된 문서의 저장·재열기 보존을 검증하지 않아 저장을 차단했습니다.",
      [{ kind: "rangeTag", count: 1 }],
    );
  }

  const status = finding?.status ?? "SUPPORTED";
  return {
    schemaVersion: 2,
    format,
    engine,
    validator: "hanul-policy",
    validationScope: "internal-structure",
    status,
    supported: status === "SUPPORTED" || status === "LOSSY",
    structure,
    issues: finding ? [finding] : [],
  };
}

export function withSerializerLosses(
  report: DocumentCompatibilityReport,
  lossReport: ContentLossReport,
): DocumentCompatibilityReport {
  if (report.status !== "SUPPORTED" || lossReport.count < 1) return report;
  const affectedElements = new Map<string, number>();
  for (const loss of lossReport.losses) {
    const kind = String(loss.subject ?? loss.code ?? "document");
    affectedElements.set(kind, (affectedElements.get(kind) ?? 0) + 1);
  }
  if (affectedElements.size === 0) affectedElements.set("serializerLoss", lossReport.count);
  return {
    ...report,
    status: "LOSSY",
    supported: true,
    issues: [{
      code: "serializer.known_loss",
      status: "LOSSY",
      feature: "document",
      message: lossReport.count + "개의 직렬화 손실 항목이 보고되었습니다. 사용자가 내용을 확인하고 명시적으로 승인해야 저장할 수 있습니다.",
      affectedElements: [...affectedElements].map(([kind, count]) => ({ kind, count })),
    }],
  };
}

export function canSaveWithCompatibility(
  report: DocumentCompatibilityReport,
  allowLossy: boolean,
): boolean {
  return report.status === "SUPPORTED" || (report.status === "LOSSY" && allowLossy);
}

export function compatibilityIssueMessage(report: DocumentCompatibilityReport, fallback: string): string {
  const finding = report.issues[0];
  if (!finding) return fallback;
  const affected = finding.affectedElements
    .map((element) => element.kind + " " + element.count + "개")
    .join(", ");
  return finding.message + (affected ? " (영향 요소: " + affected + ")" : "");
}

export function emptyCompatibilityObjectCounts() {
  return { picture: 0, rectangle: 0, ellipse: 0, textBox: 0 };
}
