use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rhwp::DocumentCore;

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
async fn export_pdf(document_bytes: Vec<u8>, output_path: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || export_pdf_blocking(&document_bytes, &output_path))
        .await
        .map_err(|error| format!("PDF 내보내기 작업을 완료하지 못했습니다. ({error})"))?
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
        .invoke_handler(tauri::generate_handler![export_pdf])
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
    use super::{export_pdf_blocking, pdf_page_count, write_atomically};

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
