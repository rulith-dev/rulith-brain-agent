use std::sync::atomic::Ordering;
use std::time::Duration;

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub(super) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut daily = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
        daily.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut prompt: Option<tokio::task::JoinHandle<()>> = None;
        loop {
            daily.tick().await; // First tick is immediate.
            let cleanup = app.clone();
            let Ok(updater) = app
                .updater_builder()
                .timeout(Duration::from_secs(10))
                .on_before_exit(move || {
                    super::CLOSING.store(true, Ordering::SeqCst);
                    super::stop();
                    cleanup.cleanup_before_exit();
                })
                .build()
            else {
                continue;
            };
            if let Ok(Some(update)) = updater.check().await {
                if prompt.as_ref().map_or(true, |task| task.is_finished()) {
                    prompt = Some(tokio::spawn(offer(app.clone(), update)));
                }
            }
        }
    });
}

async fn offer(app: AppHandle, mut update: Update) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let zh = sys_locale::get_locale()
        .unwrap_or_default()
        .split('-')
        .next()
        .is_some_and(|lang| lang.eq_ignore_ascii_case("zh"));
    let (title, install, later, failed) = if zh {
        (
            format!("Rulith Brain Agent {} 已发布", update.version),
            "更新并重启",
            "稍后",
            "未能完成更新。请检查网络连接，稍后重试。",
        )
    } else {
        (
            format!("Rulith Brain Agent {} is available", update.version),
            "Update and restart",
            "Later",
            "The update could not be completed. Please try again later.",
        )
    };
    let dialog = AsyncMessageDialog::new()
        .set_parent(&window)
        .set_title("Rulith Brain Agent");
    let notes = update.body.as_deref().unwrap_or_default();
    let choice = dialog
        .clone()
        .set_description(format!("{title}\n\n{notes}"))
        .set_buttons(MessageButtons::OkCancelCustom(install.into(), later.into()))
        .show()
        .await;
    if choice != MessageDialogResult::Custom(install.into())
        || super::CLOSING.load(Ordering::SeqCst)
    {
        return;
    }
    // The short timeout was for the manifest. The signed setup includes the Node runtime.
    update.timeout = None;
    if update.download_and_install(|_, _| {}, || {}).await.is_err() {
        dialog.set_description(failed).show().await;
    } else {
        app.restart();
    }
}
