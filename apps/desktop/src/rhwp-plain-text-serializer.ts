import { rhwpDocumentEngine, serializePlainTextWithRhwp } from "./hwp-engine";
import type { PageDefinition } from "./document-engine";
import type { PlainTextParagraph, PlainTextSerializer } from "./text-document-engine";

/**
 * File-format bridge for Hanul's blank-text engine. RHWP remains the HWP/HWPX
 * compatibility serializer; only the new engine's explicitly supported text,
 * paragraph formatting, character runs and hard page breaks cross this boundary.
 */
export async function createRhwpPlainTextSerializer(): Promise<PlainTextSerializer> {
  // Ensure the WASM runtime is ready before the synchronous DocumentSession export API is used.
  const warmup = await rhwpDocumentEngine.createBlank();
  warmup.dispose();

  return {
    serialize(paragraphs: readonly PlainTextParagraph[], format: "hwp" | "hwpx", pageDefinition: PageDefinition) {
      return serializePlainTextWithRhwp(paragraphs, format, pageDefinition);
    },
  };
}
