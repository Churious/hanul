#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
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
