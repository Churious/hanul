use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rhwp::DocumentCore;
use serde::Serialize;

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
async fn export_pdf(document_bytes: Vec<u8>, output_path: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || export_pdf_blocking(&document_bytes, &output_path))
        .await
        .map_err(|error| format!("PDF 내보내기 작업을 완료하지 못했습니다. ({error})"))?
}

#[tauri::command]
async fn commit_document_save(
    temporary_path: String,
    output_path: String,
    output_format: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        commit_document_save_blocking(&temporary_path, &output_path, &output_format)
    })
    .await
    .map_err(|error| format!("문서 저장 검증을 완료하지 못했습니다. ({error})"))?
}

#[tauri::command]
async fn inspect_document_compatibility(
    document_path: String,
    output_format: String,
) -> Result<DocumentCompatibilityReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_document_compatibility_file_blocking(&document_path, &output_format)
    })
    .await
    .map_err(|error| format!("문서 호환성 검사를 완료하지 못했습니다. ({error})"))?
}

fn inspect_document_compatibility_file_blocking(
    document_path: &str,
    output_format: &str,
) -> Result<DocumentCompatibilityReport, String> {
    let document_bytes = fs::read(document_path)
        .map_err(|error| format!("임시 문서를 읽지 못했습니다. ({error})"))?;
    inspect_document_compatibility_blocking(&document_bytes, output_format)
}

fn inspect_document_compatibility_blocking(
    document_bytes: &[u8],
    output_format: &str,
) -> Result<DocumentCompatibilityReport, String> {
    let format = output_format.to_ascii_lowercase();
    if !matches!(format.as_str(), "hwp" | "hwpx") {
        return Err("호환성 검사는 HWP 또는 HWPX 문서만 지원합니다.".to_owned());
    }
    let expected_signature: &[u8] = if format == "hwp" {
        &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
    } else {
        b"PK\x03\x04"
    };
    if !document_bytes.starts_with(expected_signature) {
        return Err(format!(
            "검사할 파일의 헤더가 {format} 형식과 일치하지 않습니다."
        ));
    }
    let parsed = DocumentCore::from_bytes(document_bytes)
        .map_err(|error| format!("문서 구조를 다시 읽지 못했습니다. ({error})"))?;
    if parsed.page_count() == 0 {
        return Err("문서에 페이지가 없어 호환성 검사를 중단했습니다.".to_owned());
    }
    Ok(document_compatibility_report(&parsed, &format))
}

fn commit_document_save_blocking(
    temporary_path: &str,
    output_path: &str,
    output_format: &str,
) -> Result<(), String> {
    let temporary = PathBuf::from(temporary_path);
    let destination = PathBuf::from(output_path);
    let format = output_format.to_ascii_lowercase();
    if !matches!(format.as_str(), "hwp" | "hwpx")
        || !destination
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case(&format))
    {
        return Err("HWP 또는 HWPX 확장자와 저장 형식이 일치하지 않습니다.".to_owned());
    }
    if temporary == destination {
        return Err("검증용 임시 파일과 원본 저장 경로가 같습니다.".to_owned());
    }
    let temporary_parent = temporary
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let destination_parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary_parent = fs::canonicalize(temporary_parent)
        .map_err(|error| format!("임시 저장 폴더에 접근하지 못했습니다. ({error})"))?;
    let destination_parent = fs::canonicalize(destination_parent)
        .map_err(|error| format!("저장 폴더에 접근하지 못했습니다. ({error})"))?;
    if temporary_parent != destination_parent {
        return Err(
            "원본 보호를 위해 임시 파일과 저장 파일은 같은 폴더에 있어야 합니다.".to_owned(),
        );
    }

    let bytes =
        fs::read(&temporary).map_err(|error| format!("임시 문서를 읽지 못했습니다. ({error})"))?;
    let expected_signature: &[u8] = if format == "hwp" {
        &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
    } else {
        b"PK\x03\x04"
    };
    if !bytes.starts_with(expected_signature) {
        return Err(format!(
            "임시 파일의 헤더가 {format} 형식과 일치하지 않습니다."
        ));
    }
    let parsed = DocumentCore::from_bytes(&bytes)
        .map_err(|error| format!("임시 문서를 다시 열어 구조를 확인하지 못했습니다. ({error})"))?;
    if parsed.page_count() == 0 {
        return Err("임시 문서에 페이지가 없어 저장을 중단했습니다.".to_owned());
    }

    let compatibility = document_compatibility_report(&parsed, &format);
    if !compatibility.supported {
        return Err(compatibility
            .issues
            .first()
            .map(|issue| issue.message.clone())
            .unwrap_or_else(|| {
                "이 문서 구조는 호환성 검증이 끝나지 않아 저장을 차단했습니다.".to_owned()
            }));
    }

    fs::rename(&temporary, &destination)
        .map_err(|error| format!("검증한 문서로 원본을 교체하지 못했습니다. ({error})"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentCompatibilityReport {
    schema_version: u8,
    format: String,
    supported: bool,
    structure: CompatibilityStructure,
    issues: Vec<CompatibilityIssue>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityStructure {
    section_count: usize,
    paragraph_count: usize,
    table_count: usize,
    object_counts: CompatibilityObjectCounts,
    text_box_paragraph_counts: Vec<usize>,
    text_box_shape_types: Vec<String>,
    text_box_unsupported_properties: Vec<bool>,
    text_box_has_nested_content: Vec<bool>,
    has_fields: bool,
    has_range_tags: bool,
    unsupported_control_count: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityObjectCounts {
    picture: usize,
    rectangle: usize,
    ellipse: usize,
    text_box: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityIssue {
    code: String,
    feature: String,
    message: String,
}

fn document_compatibility_report(
    document: &DocumentCore,
    format: &str,
) -> DocumentCompatibilityReport {
    let sections = &document.document().sections;
    let mut structure = CompatibilityStructure {
        section_count: sections.len(),
        ..CompatibilityStructure::default()
    };
    for section in sections {
        for paragraph in &section.paragraphs {
            collect_compatibility_paragraph(paragraph, &mut structure, false);
        }
    }
    let issues = if format == "hwp" {
        hwp_textbox_compatibility_issue(&structure)
            .into_iter()
            .collect()
    } else {
        Vec::new()
    };
    DocumentCompatibilityReport {
        schema_version: 1,
        format: format.to_owned(),
        supported: issues.is_empty(),
        structure,
        issues,
    }
}

fn hwp_textbox_compatibility_issue(
    structure: &CompatibilityStructure,
) -> Option<CompatibilityIssue> {
    let text_box_count = structure.object_counts.text_box;
    if text_box_count == 0 {
        return None;
    }
    let total_object_count = structure.object_counts.picture
        + structure.object_counts.rectangle
        + structure.object_counts.ellipse
        + text_box_count;
    let (code, feature, message) = if text_box_count > 1 {
        (
            "hwp.textbox.count",
            "textBox",
            "여러 글상자가 포함된 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        )
    } else if structure.section_count != 1 {
        (
            "hwp.textbox.multiple_sections",
            "structure",
            "여러 구역이 포함된 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        )
    } else if structure.has_fields || structure.has_range_tags {
        (
            "hwp.textbox.fields_or_ranges",
            "textBox",
            "필드 또는 범위 태그가 포함된 글상자 HWP는 데이터 보존을 확인하지 못해 저장을 차단했습니다.",
        )
    } else if structure
        .text_box_shape_types
        .first()
        .is_none_or(|shape| shape != "rectangle")
        || structure
            .text_box_unsupported_properties
            .first()
            .copied()
            .unwrap_or(true)
    {
        (
            "hwp.textbox.unsupported_shape",
            "textBox",
            "단순한 사각형이 아닌 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        )
    } else if structure.text_box_paragraph_counts.first().copied() != Some(1) {
        (
            "hwp.textbox.paragraph_count",
            "textBox",
            "여러 문단 또는 비어 있는 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        )
    } else if structure
        .text_box_has_nested_content
        .first()
        .copied()
        .unwrap_or(true)
    {
        (
            "hwp.textbox.nested_content",
            "textBox",
            "표·개체·필드 등 내부 구조가 포함된 글상자 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        )
    } else if structure.table_count > 0
        || total_object_count != 1
        || structure.unsupported_control_count > 0
    {
        (
            "hwp.textbox.mixed_content",
            "textBox",
            "표·그림·다른 개체와 글상자가 함께 있는 HWP는 호환성 검증이 끝나지 않아 저장을 차단했습니다.",
        )
    } else {
        return None;
    };
    Some(CompatibilityIssue {
        code: code.to_owned(),
        feature: feature.to_owned(),
        message: message.to_owned(),
    })
}

fn collect_compatibility_paragraph(
    paragraph: &rhwp::model::paragraph::Paragraph,
    structure: &mut CompatibilityStructure,
    inside_text_box: bool,
) {
    use rhwp::model::control::Control;

    structure.paragraph_count += 1;
    structure.has_range_tags |= !paragraph.range_tags.is_empty();
    structure.has_fields |=
        !paragraph.field_ranges.is_empty() || !paragraph.orphan_field_ends.is_empty();
    for control in &paragraph.controls {
        match control {
            Control::SectionDef(_) | Control::ColumnDef(_) => {}
            Control::Shape(shape) => collect_compatibility_shape(shape, structure, inside_text_box),
            Control::Table(table) => {
                structure.table_count += 1;
                if inside_text_box {
                    structure.unsupported_control_count += 1;
                }
                for cell in &table.cells {
                    for inner in &cell.paragraphs {
                        collect_compatibility_paragraph(inner, structure, inside_text_box);
                    }
                }
            }
            Control::Picture(_) => {
                structure.object_counts.picture += 1;
                structure.unsupported_control_count += 1;
            }
            Control::Field(_) => {
                structure.has_fields = true;
                structure.unsupported_control_count += 1;
            }
            Control::Header(header) => {
                structure.unsupported_control_count += 1;
                for inner in &header.paragraphs {
                    collect_compatibility_paragraph(inner, structure, inside_text_box);
                }
            }
            Control::Footer(footer) => {
                structure.unsupported_control_count += 1;
                for inner in &footer.paragraphs {
                    collect_compatibility_paragraph(inner, structure, inside_text_box);
                }
            }
            Control::Footnote(note) => {
                structure.unsupported_control_count += 1;
                for inner in &note.paragraphs {
                    collect_compatibility_paragraph(inner, structure, inside_text_box);
                }
            }
            Control::Endnote(note) => {
                structure.unsupported_control_count += 1;
                for inner in &note.paragraphs {
                    collect_compatibility_paragraph(inner, structure, inside_text_box);
                }
            }
            Control::HiddenComment(comment) => {
                structure.unsupported_control_count += 1;
                for inner in &comment.paragraphs {
                    collect_compatibility_paragraph(inner, structure, inside_text_box);
                }
            }
            _ => {
                structure.unsupported_control_count += 1;
            }
        }
    }
}

fn collect_compatibility_shape(
    shape: &rhwp::model::shape::ShapeObject,
    structure: &mut CompatibilityStructure,
    inside_text_box: bool,
) {
    use rhwp::model::shape::ShapeObject;
    use rhwp::model::table::VerticalAlign;

    match shape {
        ShapeObject::Rectangle(rectangle) => {
            if let Some(text_box) = rectangle.drawing.text_box.as_ref() {
                structure.object_counts.text_box += 1;
                structure.text_box_shape_types.push("rectangle".to_owned());
                structure
                    .text_box_paragraph_counts
                    .push(text_box.paragraphs.len());
                structure.text_box_unsupported_properties.push(
                    rectangle.round_rate != 0
                        || rectangle.drawing.caption.is_some()
                        || text_box.vertical_all
                        || !matches!(text_box.vertical_align, VerticalAlign::Top),
                );
                let nested = text_box.paragraphs.iter().any(|paragraph| {
                    !paragraph.controls.is_empty()
                        || !paragraph.range_tags.is_empty()
                        || !paragraph.field_ranges.is_empty()
                        || !paragraph.orphan_field_ends.is_empty()
                });
                structure.text_box_has_nested_content.push(nested);
                if inside_text_box {
                    structure.unsupported_control_count += 1;
                }
                for paragraph in &text_box.paragraphs {
                    collect_compatibility_paragraph(paragraph, structure, true);
                }
            } else {
                structure.object_counts.rectangle += 1;
                structure.unsupported_control_count += 1;
            }
        }
        ShapeObject::Ellipse(ellipse) => {
            if let Some(text_box) = ellipse.drawing.text_box.as_ref() {
                structure.object_counts.text_box += 1;
                structure.text_box_shape_types.push("ellipse".to_owned());
                structure
                    .text_box_paragraph_counts
                    .push(text_box.paragraphs.len());
                structure.text_box_unsupported_properties.push(true);
                structure
                    .text_box_has_nested_content
                    .push(text_box.paragraphs.iter().any(|p| !p.controls.is_empty()));
                for paragraph in &text_box.paragraphs {
                    collect_compatibility_paragraph(paragraph, structure, true);
                }
            } else {
                structure.object_counts.ellipse += 1;
                structure.unsupported_control_count += 1;
            }
        }
        ShapeObject::Picture(_) => {
            structure.object_counts.picture += 1;
            structure.unsupported_control_count += 1;
        }
        ShapeObject::Group(group) => {
            structure.unsupported_control_count += 1;
            for child in &group.children {
                collect_compatibility_shape(child, structure, inside_text_box);
            }
        }
        _ => structure.unsupported_control_count += 1,
    }
}

fn export_pdf_blocking(document_bytes: &[u8], output_path: &str) -> Result<u32, String> {
    let destination = PathBuf::from(output_path);
    if !destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("PDF 파일(.pdf) 경로를 선택해 주세요.".to_owned());
    }

    let document = DocumentCore::from_bytes(document_bytes)
        .map_err(|error| format!("문서를 PDF 변환용으로 열지 못했습니다. ({error})"))?;
    let expected_pages = document.page_count();
    let mut pdf_options = rhwp::renderer::pdf::PdfExportOptions::default();
    // The platform sans fallback is present more often than RHWP's coding-font
    // default, and is also suitable for missing equation/monospace glyphs.
    pdf_options.fallback_mono = pdf_options.fallback_sans.clone();
    let pdf_bytes = document
        .render_document_pdf_native_with_options(&pdf_options)
        .map_err(|error| format!("RHWP PDF 생성에 실패했습니다. ({error})"))?;
    let page_count = pdf_page_count(&pdf_bytes);
    if !pdf_bytes.starts_with(b"%PDF-") || !pdf_bytes.windows(5).any(|window| window == b"%%EOF") {
        return Err("RHWP가 완전한 PDF 파일을 생성하지 못했습니다.".to_owned());
    }
    if page_count == 0 || page_count != expected_pages {
        return Err(format!(
            "PDF 페이지 수가 문서와 일치하지 않습니다. (문서 {expected_pages}쪽, PDF {page_count}쪽)"
        ));
    }

    write_atomically(&destination, &pdf_bytes)
        .map_err(|error| format!("PDF 파일을 저장하지 못했습니다. ({error})"))?;
    Ok(page_count)
}

fn pdf_page_count(pdf: &[u8]) -> u32 {
    const PAGE_TYPE: &[u8] = b"/Type /Page";
    pdf.windows(PAGE_TYPE.len())
        .enumerate()
        .filter(|(index, window)| {
            if *window != PAGE_TYPE {
                return false;
            }
            // `/Pages` is the page tree. Count only a complete `/Page` name.
            pdf.get(index + PAGE_TYPE.len())
                .map_or(true, |next| is_pdf_name_delimiter(*next))
        })
        .count() as u32
}

fn is_pdf_name_delimiter(byte: u8) -> bool {
    byte.is_ascii_whitespace() || b"()<>[]{}/%".contains(&byte)
}

fn write_atomically(destination: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = destination.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "파일명이 없습니다")
    })?;

    for _ in 0..8 {
        let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = file_name.to_os_string();
        temporary_name.push(format!(".hanul-{}-{sequence}.tmp", std::process::id()));
        let temporary_path = parent.join(temporary_name);
        let mut temporary_file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };

        let result = (|| {
            temporary_file.write_all(bytes)?;
            temporary_file.sync_all()?;
            drop(temporary_file);
            fs::rename(&temporary_path, destination)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        return result;
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "임시 PDF 파일 이름을 확보하지 못했습니다",
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            export_pdf,
            commit_document_save,
            inspect_document_compatibility
        ])
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{InputMethodContextExt, WebViewExt};

                // Wry disables WebKitGTK preedit by default. Re-enable it so Linux IMEs
                // can deliver native composition events to the editor input surface.
                let window = _app
                    .get_webview_window("main")
                    .expect("main webview must exist");
                window.with_webview(|webview| {
                    if let Some(context) = webview.inner().input_method_context() {
                        context.set_enable_preedit(true);
                    }
                })?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Hanul desktop application");
}

#[cfg(test)]
mod tests {
    use super::{
        CompatibilityStructure, commit_document_save_blocking, document_compatibility_report,
        export_pdf_blocking, hwp_textbox_compatibility_issue,
        inspect_document_compatibility_file_blocking, pdf_page_count, write_atomically,
    };
    use rhwp::DocumentCore;

    #[test]
    fn blocks_unverified_hwp_textbox_save_and_preserves_original() {
        let sequence = super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed);
        let temporary = std::env::temp_dir().join(format!(
            "hanul-textbox-save-{}-{sequence}.tmp",
            std::process::id()
        ));
        let destination = std::env::temp_dir().join(format!(
            "hanul-textbox-save-{}-{sequence}.hwp",
            std::process::id()
        ));
        let mut source = DocumentCore::new_empty();
        source
            .create_blank_document_native()
            .expect("create blank HWP");
        source
            .create_shape_control_native(
                0,
                0,
                0,
                7200,
                3600,
                0,
                0,
                false,
                "InFrontOfText",
                "textbox",
                false,
                false,
                &[],
            )
            .expect("create textbox");
        source
            .create_shape_control_native(
                0,
                0,
                0,
                3600,
                1800,
                0,
                0,
                false,
                "InFrontOfText",
                "second textbox",
                false,
                false,
                &[],
            )
            .expect("create second textbox");
        let staged_bytes = source.export_hwp_native().expect("serialize staged HWP");
        let staged = DocumentCore::from_bytes(&staged_bytes).expect("reopen staged HWP");
        let report = document_compatibility_report(&staged, "hwp");
        assert_eq!(report.structure.object_counts.text_box, 1, "{report:?}");
        assert_eq!(report.structure.object_counts.rectangle, 1, "{report:?}");
        assert_eq!(report.issues[0].code, "hwp.textbox.unsupported_shape");
        std::fs::write(&temporary, &staged_bytes).expect("write staged HWP");
        std::fs::write(&destination, b"original HWP").expect("seed existing HWP");

        let error = commit_document_save_blocking(
            temporary.to_str().unwrap(),
            destination.to_str().unwrap(),
            "hwp",
        )
        .expect_err("unverified text-box HWP must stay blocked");

        assert!(error.contains("단순한 사각형이 아닌 글상자 HWP"));
        assert_eq!(std::fs::read(&destination).unwrap(), b"original HWP");
        assert!(DocumentCore::from_bytes(&staged_bytes).is_ok());
        assert!(temporary.exists());
        std::fs::remove_file(temporary).unwrap();
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn reports_a_specific_reason_for_multiple_textboxes() {
        let structure = CompatibilityStructure {
            section_count: 1,
            object_counts: super::CompatibilityObjectCounts {
                text_box: 2,
                ..super::CompatibilityObjectCounts::default()
            },
            text_box_paragraph_counts: vec![1, 1],
            text_box_shape_types: vec!["rectangle".to_owned(), "rectangle".to_owned()],
            text_box_unsupported_properties: vec![false, false],
            text_box_has_nested_content: vec![false, false],
            ..CompatibilityStructure::default()
        };
        let issue =
            hwp_textbox_compatibility_issue(&structure).expect("multiple textboxes are blocked");
        assert_eq!(issue.code, "hwp.textbox.count");
        assert!(issue.message.contains("여러 글상자가 포함된 HWP"));
    }

    #[test]
    fn saves_the_hanword_verified_single_textbox_golden_through_atomic_product_commit() {
        let sequence = super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed);
        let temporary = std::env::temp_dir().join(format!(
            "hanul-verified-textbox-{}-{sequence}.tmp",
            std::process::id()
        ));
        let destination = std::env::temp_dir().join(format!(
            "hanul-verified-textbox-{}-{sequence}.hwp",
            std::process::id()
        ));
        let bytes =
            include_bytes!("../../test-fixtures/hanul-textbox-body-50x24-hanword-gui-verified.hwp");
        assert!(DocumentCore::from_bytes(bytes).is_ok());
        std::fs::write(&temporary, bytes).expect("write staged golden HWP");
        let report =
            inspect_document_compatibility_file_blocking(temporary.to_str().unwrap(), "hwp")
                .expect("inspect the staged Hanword-verified textbox golden");
        assert!(report.supported, "{:?}", report.issues);
        assert_eq!(report.schema_version, 1);
        assert_eq!(report.structure.section_count, 1);
        assert_eq!(report.structure.object_counts.text_box, 1);
        assert_eq!(report.structure.text_box_shape_types, ["rectangle"]);
        assert_eq!(report.structure.text_box_paragraph_counts, [1]);
        assert_eq!(report.structure.text_box_unsupported_properties, [false]);
        assert_eq!(report.structure.text_box_has_nested_content, [false]);
        commit_document_save_blocking(
            temporary.to_str().unwrap(),
            destination.to_str().unwrap(),
            "hwp",
        )
        .expect("the Hanword-verified simple textbox structure is supported");

        let committed = std::fs::read(&destination).expect("read committed golden");
        assert_eq!(committed, bytes);
        assert!(DocumentCore::from_bytes(&committed).is_ok());
        assert!(!temporary.exists());
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    #[ignore = "run with HANUL_PRODUCT_HWP_INPUT/OUTPUT to prepare a disposable Hanword GUI check"]
    fn commits_product_serializer_textbox_output_for_hanword_gui_validation() {
        let input = std::env::var("HANUL_PRODUCT_HWP_INPUT")
            .expect("set HANUL_PRODUCT_HWP_INPUT to the frontend product-export bytes");
        let output = std::env::var("HANUL_PRODUCT_HWP_OUTPUT")
            .expect("set HANUL_PRODUCT_HWP_OUTPUT to a new disposable HWP path");
        let destination = std::path::PathBuf::from(output);
        assert!(
            !destination.exists(),
            "GUI validation output must be a new path"
        );
        let parent = destination.parent().expect("output parent");
        let temporary = parent.join(format!(
            ".hanul-product-save-{}-{}.tmp",
            std::process::id(),
            super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed)
        ));
        let input_bytes = std::fs::read(input).expect("read frontend product export");
        std::fs::write(&temporary, &input_bytes).expect("stage frontend product export");

        commit_document_save_blocking(
            temporary.to_str().unwrap(),
            destination.to_str().unwrap(),
            "hwp",
        )
        .expect("run the normal format, parse, textbox-policy and atomic-rename pipeline");

        let committed = std::fs::read(&destination).expect("read committed HWP");
        assert_eq!(committed, input_bytes);
        assert!(DocumentCore::from_bytes(&committed).is_ok());
    }

    #[test]
    fn validates_hwp_before_atomically_replacing_existing_document() {
        let sequence = super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed);
        let temporary = std::env::temp_dir().join(format!(
            "hanul-document-save-{}-{sequence}.tmp",
            std::process::id()
        ));
        let destination = std::env::temp_dir().join(format!(
            "hanul-document-save-{}-{sequence}.hwp",
            std::process::id()
        ));
        let mut source = DocumentCore::new_empty();
        source
            .create_blank_document_native()
            .expect("create blank HWP");
        let bytes = source.export_hwp_native().expect("serialize blank HWP");
        std::fs::write(&temporary, &bytes).expect("write staged HWP");
        std::fs::write(&destination, b"old HWP").expect("seed original HWP");

        commit_document_save_blocking(
            temporary.to_str().unwrap(),
            destination.to_str().unwrap(),
            "hwp",
        )
        .expect("validate and replace HWP");

        let saved = std::fs::read(&destination).expect("read replaced HWP");
        assert_eq!(saved, bytes);
        assert!(DocumentCore::from_bytes(&saved).is_ok());
        assert!(!temporary.exists());
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn validates_hwpx_before_atomically_replacing_existing_document() {
        let sequence = super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed);
        let temporary = std::env::temp_dir().join(format!(
            "hanul-document-save-{}-{sequence}.tmp",
            std::process::id()
        ));
        let destination = std::env::temp_dir().join(format!(
            "hanul-document-save-{}-{sequence}.hwpx",
            std::process::id()
        ));
        let mut source = DocumentCore::new_empty();
        source
            .create_blank_document_native()
            .expect("create blank document");
        let bytes = source.export_hwpx_native().expect("serialize blank HWPX");
        std::fs::write(&temporary, &bytes).expect("write staged HWPX");
        std::fs::write(&destination, b"old HWPX").expect("seed original HWPX");

        commit_document_save_blocking(
            temporary.to_str().unwrap(),
            destination.to_str().unwrap(),
            "hwpx",
        )
        .expect("validate and replace HWPX");

        let saved = std::fs::read(&destination).expect("read replaced HWPX");
        assert_eq!(saved, bytes);
        assert!(DocumentCore::from_bytes(&saved).is_ok());
        assert!(!temporary.exists());
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn failed_document_validation_leaves_original_untouched() {
        let sequence = super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed);
        let temporary = std::env::temp_dir().join(format!(
            "hanul-document-invalid-{}-{sequence}.tmp",
            std::process::id()
        ));
        let destination = std::env::temp_dir().join(format!(
            "hanul-document-invalid-{}-{sequence}.hwp",
            std::process::id()
        ));
        std::fs::write(&temporary, b"not an HWP").expect("write invalid staged file");
        std::fs::write(&destination, b"original HWP contents").expect("seed original HWP");

        let error = commit_document_save_blocking(
            temporary.to_str().unwrap(),
            destination.to_str().unwrap(),
            "hwp",
        )
        .expect_err("invalid HWP must not replace original");
        assert!(error.contains("헤더가 hwp 형식과 일치하지 않습니다"));
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"original HWP contents"
        );
        assert!(temporary.exists());
        std::fs::remove_file(temporary).unwrap();
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn counts_page_objects_without_counting_page_tree() {
        let pdf =
            b"%PDF-1.7\n<< /Type /Pages /Count 2 >>\n<< /Type /Page >>\n<< /Type /Page\n>>\n%%EOF";
        assert_eq!(pdf_page_count(pdf), 2);
    }

    #[test]
    fn invalid_document_does_not_create_or_truncate_the_destination() {
        let destination = std::env::temp_dir().join(format!(
            "hanul-pdf-existing-{}-{}.pdf",
            std::process::id(),
            super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed)
        ));
        std::fs::write(&destination, b"original PDF contents").expect("seed destination");

        let error = export_pdf_blocking(b"not a document", destination.to_str().unwrap())
            .expect_err("invalid source must fail");
        assert!(error.contains("문서를 PDF 변환용으로 열지 못했습니다"));
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"original PDF contents"
        );
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn atomically_replaces_an_existing_pdf() {
        let destination = std::env::temp_dir().join(format!(
            "hanul-pdf-replace-{}-{}.pdf",
            std::process::id(),
            super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed)
        ));
        std::fs::write(&destination, b"old PDF").expect("seed destination");

        write_atomically(&destination, b"new PDF").expect("replace destination");
        assert_eq!(std::fs::read(&destination).unwrap(), b"new PDF");
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn exports_hwp_and_hwpx_document_content_to_single_page_pdfs() {
        use rhwp::wasm_api::HwpDocument;

        let mut source_document = HwpDocument::create_empty();
        source_document
            .create_blank_document()
            .expect("create blank RHWP document");
        source_document
            .insert_text(0, 0, 0, "Hanul PDF content test 한울 PDF 내용")
            .expect("insert content into source document");

        let mut blank_document = HwpDocument::create_empty();
        blank_document
            .create_blank_document()
            .expect("create blank comparison document");
        let blank_hwp = blank_document.export_hwp().expect("export blank HWP");
        let blank_core = rhwp::DocumentCore::from_bytes(&blank_hwp).expect("reopen blank HWP");
        let blank_pdf = blank_core
            .render_document_pdf_native()
            .expect("render blank document PDF");

        let sources = [
            ("hwp", source_document.export_hwp().expect("export HWP")),
            ("hwpx", source_document.export_hwpx().expect("export HWPX")),
        ];
        for (format, source_bytes) in sources {
            let reopened = rhwp::DocumentCore::from_bytes(&source_bytes)
                .unwrap_or_else(|error| panic!("reopen {format}: {error}"));
            let text_match = reopened
                .search_text_native(
                    "Hanul PDF content test 한울 PDF 내용",
                    0,
                    0,
                    0,
                    true,
                    false,
                    false,
                )
                .unwrap_or_else(|error| panic!("search {format} source: {error}"));
            assert!(
                text_match.contains("\"found\":true"),
                "{format} retains source text: {text_match}"
            );
            let output_path = std::env::temp_dir().join(format!(
                "hanul-pdf-{format}-{}-{}.pdf",
                std::process::id(),
                super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed)
            ));

            let pages = export_pdf_blocking(&source_bytes, output_path.to_str().unwrap())
                .unwrap_or_else(|error| panic!("{format} to PDF failed: {error}"));
            let pdf = std::fs::read(&output_path).expect("read generated PDF");
            assert_eq!(pages, 1, "{format} page count");
            assert_eq!(pdf_page_count(&pdf), 1, "{format} generated PDF page tree");
            assert!(
                pdf.len() > 500,
                "{format} PDF must contain rendered page content"
            );
            assert_ne!(
                pdf, blank_pdf,
                "{format} PDF must include its source document's page content"
            );
            assert!(pdf.windows(5).any(|window| window == b"%%EOF"));
            std::fs::remove_file(output_path).expect("remove generated PDF fixture");
        }
    }

    #[test]
    fn exports_explicit_page_breaks_as_multiple_pages_for_hwp_and_hwpx() {
        use rhwp::wasm_api::HwpDocument;

        let mut document = HwpDocument::create_empty();
        document
            .create_blank_document()
            .expect("create blank RHWP document");
        document
            .insert_text(0, 0, 0, "First PDF page")
            .expect("insert first page content");
        document
            .insert_page_break(0, 0, 14)
            .expect("insert explicit page break");

        let sources = [
            ("hwp", document.export_hwp().expect("export HWP")),
            ("hwpx", document.export_hwpx().expect("export HWPX")),
        ];
        for (format, source_bytes) in sources {
            let output_path = std::env::temp_dir().join(format!(
                "hanul-pdf-break-{format}-{}-{}.pdf",
                std::process::id(),
                super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed)
            ));

            let pages = export_pdf_blocking(&source_bytes, output_path.to_str().unwrap())
                .unwrap_or_else(|error| panic!("{format} page break to PDF failed: {error}"));
            assert_eq!(pages, 2, "{format} PDF keeps the explicit page break");
            let pdf = std::fs::read(&output_path).expect("read generated multi-page PDF");
            assert_eq!(pdf_page_count(&pdf), 2, "{format} PDF page tree");
            std::fs::remove_file(output_path).expect("remove generated PDF fixture");
        }
    }

    #[test]
    fn renders_table_cell_content_to_pdf_for_hwp_and_hwpx() {
        use rhwp::wasm_api::HwpDocument;

        fn json_index(value: &str, name: &str) -> usize {
            let marker = format!("\"{name}\":");
            let start = value.find(&marker).expect("table address field") + marker.len();
            let end = value[start..]
                .find(|character: char| !character.is_ascii_digit())
                .map_or(value.len(), |offset| start + offset);
            value[start..end].parse().expect("table address index")
        }

        let mut document = HwpDocument::create_empty();
        document
            .create_blank_document()
            .expect("create blank RHWP document");
        let mut core =
            rhwp::DocumentCore::from_bytes(&document.export_hwp().expect("export blank template"))
                .expect("open blank template in native core");
        let table_position = core
            .create_table_native(0, 0, 0, 2, 2)
            .expect("insert a 2 by 2 table");
        let parent_para = json_index(&table_position, "paraIdx");
        let control_index = json_index(&table_position, "controlIdx");
        core.insert_text_in_cell_native(0, parent_para, control_index, 0, 0, 0, "PDF table cell")
            .expect("insert table-cell content");

        let sources = [
            ("hwp", core.export_hwp_native().expect("export HWP")),
            ("hwpx", core.export_hwpx_native().expect("export HWPX")),
        ];
        for (format, source_bytes) in sources {
            let reopened = rhwp::DocumentCore::from_bytes(&source_bytes)
                .unwrap_or_else(|error| panic!("reopen {format}: {error}"));
            let text_match = reopened
                .search_text_native("PDF table cell", 0, 0, 0, true, false, true)
                .unwrap_or_else(|error| panic!("search {format} table: {error}"));
            assert!(
                text_match.contains("\"found\":true"),
                "{format} preserves table-cell content"
            );
            let output_path = std::env::temp_dir().join(format!(
                "hanul-pdf-table-{format}-{}-{}.pdf",
                std::process::id(),
                super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed)
            ));

            let pages = export_pdf_blocking(&source_bytes, output_path.to_str().unwrap())
                .unwrap_or_else(|error| panic!("{format} table to PDF failed: {error}"));
            let pdf = std::fs::read(&output_path).expect("read generated table PDF");
            assert_eq!(pages, 1, "{format} table page count");
            assert!(
                pdf.len() > 500,
                "{format} table PDF has rendered page content"
            );
            std::fs::remove_file(output_path).expect("remove generated PDF fixture");
        }
    }

    #[test]
    fn renders_embedded_picture_content_to_pdf_for_hwp_and_hwpx() {
        use rhwp::wasm_api::HwpDocument;

        fn minimal_png() -> Vec<u8> {
            let mut bytes = Vec::new();
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("write PNG header");
            writer
                .write_image_data(&[0x35, 0x75, 0xB5, 0xFF])
                .expect("write PNG pixel");
            drop(writer);
            bytes
        }

        let mut document = HwpDocument::create_empty();
        document
            .create_blank_document()
            .expect("create blank RHWP document");
        let mut core =
            rhwp::DocumentCore::from_bytes(&document.export_hwp().expect("export blank template"))
                .expect("open blank template in native core");
        core.insert_picture_native(
            0,
            0,
            0,
            &[],
            &minimal_png(),
            5_000,
            5_000,
            1,
            1,
            "png",
            "PDF export test image",
            None,
            None,
        )
        .expect("insert embedded image");
        let mut blank_document = HwpDocument::create_empty();
        blank_document
            .create_blank_document()
            .expect("create blank comparison document");
        let blank_bytes = blank_document.export_hwp().expect("export blank HWP");
        let blank_core = rhwp::DocumentCore::from_bytes(&blank_bytes).expect("reopen blank HWP");
        let blank_pdf = blank_core
            .render_document_pdf_native()
            .expect("render blank comparison PDF");

        let sources = [
            ("hwp", core.export_hwp_native().expect("export HWP")),
            ("hwpx", core.export_hwpx_native().expect("export HWPX")),
        ];
        for (format, source_bytes) in sources {
            let output_path = std::env::temp_dir().join(format!(
                "hanul-pdf-image-{format}-{}-{}.pdf",
                std::process::id(),
                super::NEXT_TEMP_FILE.fetch_add(1, super::Ordering::Relaxed)
            ));

            let pages = export_pdf_blocking(&source_bytes, output_path.to_str().unwrap())
                .unwrap_or_else(|error| panic!("{format} image to PDF failed: {error}"));
            let pdf = std::fs::read(&output_path).expect("read generated image PDF");
            assert_eq!(pages, 1, "{format} image page count");
            assert!(
                pdf.len() > 500,
                "{format} image PDF has rendered page content"
            );
            assert_ne!(
                pdf, blank_pdf,
                "{format} PDF includes the embedded image content"
            );
            std::fs::remove_file(output_path).expect("remove generated PDF fixture");
        }
    }
}
