const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

export type FileValidation =
  | { ok: true }
  | { ok: false; message: string };

export function validateDocumentFile(fileName: string, size: number): FileValidation {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (extension !== ".hwp" && extension !== ".hwpx") {
    return { ok: false, message: "HWP 또는 HWPX 파일만 열 수 있습니다." };
  }
  if (size === 0) {
    return { ok: false, message: "선택한 파일이 비어 있습니다." };
  }
  if (size > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      message: "현재 버전은 200MB 이하의 문서만 열 수 있습니다.",
    };
  }
  return { ok: true };
}

export function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10));
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function sanitizeRenderedSvg(
  purifier: { sanitize: (source: string, options: object) => string | TrustedHTML },
  source: string,
) {
  if (source.length > 16 * 1024 * 1024) {
    throw new Error("렌더링된 페이지가 허용 크기를 초과했습니다.");
  }

  const cleaned = String(
    purifier.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed"],
    }),
  );
  const parsed = new DOMParser().parseFromString(cleaned, "image/svg+xml");
  if (
    parsed.querySelector("parsererror") ||
    parsed.documentElement.localName.toLowerCase() !== "svg"
  ) {
    throw new Error("문서 엔진이 올바른 SVG 페이지를 만들지 못했습니다.");
  }

  for (const element of Array.from(parsed.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name === "href" || name === "xlink:href") {
        const localReference = value.startsWith("#");
        const embeddedImage =
          /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(value);
        if (!localReference && !embeddedImage) element.removeAttribute(attribute.name);
        continue;
      }

      const urlReferences = value.match(/url\(([^)]*)\)/gi) ?? [];
      if (
        urlReferences.some((reference) => {
          const target = reference
            .slice(reference.indexOf("(") + 1, -1)
            .replace(/^["']|["']$/g, "")
            .trim();
          return !target.startsWith("#");
        })
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return parsed.documentElement.outerHTML;
}
