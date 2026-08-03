#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod app;
mod storage;
mod theme;

use iced::{window, Size};

fn main() -> iced::Result {
    let window = window::Settings {
        size: Size::new(1280.0, 820.0),
        min_size: Some(Size::new(860.0, 560.0)),
        position: window::Position::Centered,
        decorations: false,
        exit_on_close_request: false,
        ..Default::default()
    };

    iced::application(
        app::LeafMarkApp::boot,
        app::LeafMarkApp::update,
        app::LeafMarkApp::view,
    )
    .title(app::LeafMarkApp::title)
    .theme(app::LeafMarkApp::theme)
    .subscription(app::LeafMarkApp::subscription)
    .window(window)
    .run()
}
