import type { DocumentObject } from "./document-engine";

export interface ObjectDragBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function previewObjectDrag(
  object: DocumentObject,
  start: { x: number; y: number },
  current: { x: number; y: number },
  resize: boolean,
): ObjectDragBounds {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (!resize) {
    return {
      x: object.bounds.x + dx,
      y: object.bounds.y + dy,
      width: object.bounds.width,
      height: object.bounds.height,
    };
  }
  const minimum = 96 / 25.4;
  if (object.kind === "picture" && object.bounds.width > 0 && object.bounds.height > 0) {
    const widthScale = 1 + dx / object.bounds.width;
    const heightScale = 1 + dy / object.bounds.height;
    const scale = Math.max(minimum / object.bounds.width, minimum / object.bounds.height,
      Math.abs(dx / object.bounds.width) >= Math.abs(dy / object.bounds.height) ? widthScale : heightScale);
    return {
      x: object.bounds.x,
      y: object.bounds.y,
      width: object.bounds.width * scale,
      height: object.bounds.height * scale,
    };
  }
  return {
    x: object.bounds.x,
    y: object.bounds.y,
    width: Math.max(minimum, object.bounds.width + dx),
    height: Math.max(minimum, object.bounds.height + dy),
  };
}
