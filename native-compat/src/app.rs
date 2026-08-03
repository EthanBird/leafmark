use crate::storage::{
    ArchiveEntry, DocumentEntry, DocumentOrigin, NativeStorage, OpenedDocument, StorageError,
};
use crate::theme::{self, Appearance, Palette};
use iced::keyboard::{self, Key};
use iced::widget::{
    button, column, container, markdown, mouse_area, pick_list, row, rule, scrollable, stack, text,
    text_editor, Space,
};
use iced::{alignment, mouse, time, window, Alignment, Element, Length, Subscription, Task, Theme};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const AUTOSAVE_DELAY: Duration = Duration::from_millis(900);
const AUTOSAVE_TICK: Duration = Duration::from_millis(350);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SidebarPage {
    Workspace,
    History,
    Favorites,
}

#[derive(Debug)]
struct DocumentTab {
    key: String,
    path: String,
    title: String,
    origin: DocumentOrigin,
    archive_id: String,
    editor: text_editor::Content,
    preview: markdown::Content,
    saved_content: String,
    dirty: bool,
    autosave_paused: bool,
    modified_at: Instant,
}

impl DocumentTab {
    fn from_opened(document: OpenedDocument) -> Self {
        let key = document_key(document.origin, &document.path, &document.archive_id);
        let title = document_title(&document.path);
        let content = document.content;

        Self {
            key,
            path: document.path,
            title,
            origin: document.origin,
            archive_id: document.archive_id,
            editor: text_editor::Content::with_text(&content),
            preview: markdown::Content::parse(&content),
            saved_content: content,
            dirty: false,
            autosave_paused: false,
            modified_at: Instant::now(),
        }
    }

    fn current_content(&self) -> String {
        self.editor.text()
    }
}

#[derive(Debug, Clone)]
struct SaveRequest {
    tab_key: String,
    path: String,
    origin: DocumentOrigin,
    archive_id: String,
    content: String,
}

#[derive(Debug, Clone)]
pub(crate) struct SaveOutcome {
    tab_key: String,
    content: String,
    result: Result<ArchiveEntry, String>,
}

#[derive(Debug, Clone)]
pub(crate) enum Message {
    SelectSidebar(SidebarPage),
    ToggleSettings,
    SetPalette(Palette),
    SetAppearance(Appearance),
    ChooseWorkspace,
    OpenFileDialog,
    NewDocument,
    Refresh,
    OpenWorkspace(String),
    OpenArchive(String),
    ToggleFavorite(String, bool),
    SaveArchiveToWorkspace(String),
    ArchiveSavedToWorkspace(String, Result<String, String>),
    ClearHistory,
    ActivateTab(usize),
    CloseTab(usize),
    EditorAction(text_editor::Action),
    SaveActive,
    SaveFinished(SaveOutcome),
    AutosaveTick(Instant),
    KeyboardEvent(keyboard::Event),
    WindowEvent(window::Id, window::Event),
    LinkClicked(String),
    DragWindow,
    ResizeWindow(window::Direction),
    MinimizeWindow,
    ToggleMaximizeWindow,
    RequestClose,
    CloseWindowResolved(Option<window::Id>),
}

pub struct LeafMarkApp {
    storage: Option<Arc<Mutex<NativeStorage>>>,
    workspace_entries: Vec<DocumentEntry>,
    archive_entries: Vec<ArchiveEntry>,
    tabs: Vec<DocumentTab>,
    active_tab: Option<usize>,
    sidebar_page: SidebarPage,
    palette: Palette,
    appearance: Appearance,
    show_settings: bool,
    status: String,
    pending_saves: HashSet<String>,
    pending_archive_copies: HashSet<String>,
    pending_tab_closes: HashSet<String>,
    close_after_save: Option<window::Id>,
    closing_window: bool,
}

impl LeafMarkApp {
    /// Initializes storage and processes command-line documents before the first
    /// frame. This avoids briefly displaying an empty document when Windows or
    /// another app launches LeafMark with a Markdown path.
    pub fn boot() -> Self {
        let mut app = Self {
            storage: None,
            workspace_entries: Vec::new(),
            archive_entries: Vec::new(),
            tabs: Vec::new(),
            active_tab: None,
            sidebar_page: SidebarPage::Workspace,
            palette: Palette::Leaf,
            appearance: Appearance::Light,
            show_settings: false,
            status: String::from("正在打开文档库…"),
            pending_saves: HashSet::new(),
            pending_archive_copies: HashSet::new(),
            pending_tab_closes: HashSet::new(),
            close_after_save: None,
            closing_window: false,
        };

        match NativeStorage::open_default() {
            Ok(storage) => {
                if let Ok(Some(settings)) = storage.load_settings_value() {
                    app.apply_settings(&settings);
                }
                app.storage = Some(Arc::new(Mutex::new(storage)));
                app.refresh_lists();

                let startup_paths: Vec<PathBuf> = env::args_os()
                    .skip(1)
                    .map(PathBuf::from)
                    .filter(|path| is_markdown_path(path))
                    .collect();

                for path in &startup_paths {
                    app.open_path(path);
                }

                if app.tabs.is_empty() && startup_paths.is_empty() {
                    app.create_workspace_document();
                }
            }
            Err(error) => {
                app.status = format!("无法初始化文档库：{error}");
            }
        }

        app
    }

    pub fn title(&self) -> String {
        match self.active_tab.and_then(|index| self.tabs.get(index)) {
            Some(tab) if tab.dirty => format!("一叶 · {} *", tab.title),
            Some(tab) => format!("一叶 · {}", tab.title),
            None => String::from("一叶"),
        }
    }

    pub fn theme(&self) -> Theme {
        theme::iced_theme(self.palette, self.appearance)
    }

    pub fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            time::every(AUTOSAVE_TICK).map(Message::AutosaveTick),
            keyboard::listen().map(Message::KeyboardEvent),
            window::events().map(|(id, event)| Message::WindowEvent(id, event)),
        ])
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::SelectSidebar(page) => {
                self.sidebar_page = page;
                self.show_settings = false;
                Task::none()
            }
            Message::ToggleSettings => {
                self.show_settings = !self.show_settings;
                Task::none()
            }
            Message::SetPalette(palette) => {
                self.palette = palette;
                self.persist_settings();
                Task::none()
            }
            Message::SetAppearance(appearance) => {
                self.appearance = appearance;
                self.persist_settings();
                Task::none()
            }
            Message::ChooseWorkspace => {
                if !self.pending_archive_copies.is_empty() {
                    self.status = String::from("正在保存历史副本到文档库，完成前不能切换文档库");
                    return Task::none();
                }
                if self
                    .tabs
                    .iter()
                    .any(|tab| tab.origin == DocumentOrigin::Workspace)
                {
                    self.status = String::from("请先关闭所有文档库标签页，再更换文档库文件夹");
                    return Task::none();
                }
                if let Some(path) = choose_workspace_folder() {
                    let result = self.with_storage_mut(|storage| {
                        storage.set_workspace(&path).map_err(storage_message)
                    });
                    match result {
                        Ok(()) => {
                            self.persist_settings();
                            self.refresh_lists();
                            self.status = String::from("已切换文档库");
                        }
                        Err(error) => self.status = error,
                    }
                }
                Task::none()
            }
            Message::OpenFileDialog => {
                if let Some(path) = choose_markdown_file() {
                    self.open_path(&path);
                }
                Task::none()
            }
            Message::NewDocument => {
                self.create_workspace_document();
                Task::none()
            }
            Message::Refresh => {
                self.refresh_lists();
                Task::none()
            }
            Message::OpenWorkspace(path) => {
                let result = self.with_storage_mut(|storage| {
                    storage
                        .open_workspace_document(&path)
                        .map_err(storage_message)
                });
                self.handle_open_result(result);
                Task::none()
            }
            Message::OpenArchive(id) => {
                let result = self.with_storage_mut(|storage| {
                    storage.open_archived(&id).map_err(storage_message)
                });
                self.handle_open_result(result);
                Task::none()
            }
            Message::ToggleFavorite(id, favorite) => {
                let result = self.with_storage_mut(|storage| {
                    storage.set_favorite(&id, favorite).map_err(storage_message)
                });
                match result {
                    Ok(entries) => {
                        self.archive_entries = entries;
                        self.status = if favorite {
                            String::from("已加入收藏")
                        } else {
                            String::from("已取消收藏")
                        };
                    }
                    Err(error) => self.status = error,
                }
                Task::none()
            }
            Message::SaveArchiveToWorkspace(id) => {
                if self.pending_archive_copies.contains(&id) {
                    self.status = String::from("该文档正在保存到文档库，请稍候");
                    return Task::none();
                }
                if self.tabs.iter().any(|tab| {
                    tab.origin == DocumentOrigin::Archive
                        && tab.archive_id == id
                        && (tab.dirty || self.pending_saves.contains(&tab.key))
                }) {
                    self.status = String::from("该历史副本有未保存更改或正在保存，请先完成保存");
                    return Task::none();
                }
                let Some(storage) = self.storage.clone() else {
                    self.status = String::from("文档库尚未初始化");
                    return Task::none();
                };
                self.pending_archive_copies.insert(id.clone());
                self.status = String::from("正在后台保存到文档库…");
                Task::perform(save_archive_to_workspace(storage, id), |(id, result)| {
                    Message::ArchiveSavedToWorkspace(id, result)
                })
            }
            Message::ArchiveSavedToWorkspace(id, result) => {
                self.pending_archive_copies.remove(&id);
                match result {
                    Ok(path) => {
                        if self.closing_window {
                            self.status = String::from("历史副本已保存到文档库，正在关闭…");
                        } else {
                            let open_result = self.with_storage_mut(|storage| {
                                storage
                                    .open_workspace_document(&path)
                                    .map_err(storage_message)
                            });
                            self.handle_open_result(open_result);
                            self.status = String::from("已保存到文档库并打开可编辑副本");
                        }
                    }
                    Err(error) => {
                        self.close_after_save = None;
                        self.closing_window = false;
                        self.status = format!("保存到文档库失败：{error}");
                    }
                }
                if let Some(id) = self.close_after_save {
                    if self.pending_archive_copies.is_empty()
                        && self.pending_saves.is_empty()
                        && self.tabs.iter().all(|tab| !tab.dirty)
                    {
                        self.close_after_save = None;
                        return window::close(id);
                    }
                }
                Task::none()
            }
            Message::ClearHistory => {
                if !self.pending_archive_copies.is_empty() {
                    self.status = String::from("正在保存历史副本到文档库，完成前不能清理历史记录");
                    return Task::none();
                }
                if self
                    .tabs
                    .iter()
                    .any(|tab| tab.origin == DocumentOrigin::Archive)
                {
                    self.status = String::from("请先关闭所有历史记录副本标签页，再清理历史记录");
                    return Task::none();
                }
                let result = self
                    .with_storage_mut(|storage| storage.clear_history().map_err(storage_message));
                match result {
                    Ok(entries) => {
                        self.archive_entries = entries;
                        self.status = String::from("历史记录已清理；收藏文档仍保留");
                    }
                    Err(error) => self.status = error,
                }
                Task::none()
            }
            Message::ActivateTab(index) => {
                if index < self.tabs.len() {
                    self.active_tab = Some(index);
                }
                Task::none()
            }
            Message::CloseTab(index) => self.request_tab_close(index),
            Message::EditorAction(action) => {
                if self.closing_window {
                    return Task::none();
                }
                let is_edit = action.is_edit();
                if let Some(tab) = self.active_tab_mut() {
                    tab.editor.perform(action);
                    if is_edit {
                        let content = tab.editor.text();
                        tab.preview = markdown::Content::parse(&content);
                        tab.dirty = content != tab.saved_content;
                        tab.autosave_paused = false;
                        tab.modified_at = Instant::now();
                    }
                }
                Task::none()
            }
            Message::SaveActive => {
                let Some(index) = self.active_tab else {
                    return Task::none();
                };
                if let Some(tab) = self.tabs.get_mut(index) {
                    tab.autosave_paused = false;
                }
                self.schedule_save(index)
            }
            Message::SaveFinished(outcome) => self.finish_save(outcome),
            Message::AutosaveTick(now) => {
                let due: Vec<usize> = self
                    .tabs
                    .iter()
                    .enumerate()
                    .filter_map(|(index, tab)| {
                        (tab.dirty
                            && !tab.autosave_paused
                            && now.saturating_duration_since(tab.modified_at) >= AUTOSAVE_DELAY)
                            .then_some(index)
                    })
                    .collect();
                Task::batch(due.into_iter().map(|index| self.schedule_save(index)))
            }
            Message::KeyboardEvent(event) => {
                if let keyboard::Event::KeyPressed {
                    key,
                    modifiers,
                    repeat,
                    ..
                } = event
                {
                    if !repeat && modifiers.command() {
                        if let Key::Character(value) = key.as_ref() {
                            if value.eq_ignore_ascii_case("s") {
                                return self.update(Message::SaveActive);
                            }
                            if value.eq_ignore_ascii_case("o") {
                                return self.update(Message::OpenFileDialog);
                            }
                            if value.eq_ignore_ascii_case("n") {
                                return self.update(Message::NewDocument);
                            }
                        }
                    }
                }
                Task::none()
            }
            Message::WindowEvent(id, event) => match event {
                window::Event::FileDropped(path) => {
                    self.open_path(&path);
                    Task::none()
                }
                window::Event::CloseRequested => self.request_window_close(id),
                _ => Task::none(),
            },
            Message::LinkClicked(uri) => {
                self.status = format!("链接：{uri}（兼容版不会内嵌打开网页）");
                Task::none()
            }
            Message::DragWindow => latest_window_task(window::drag),
            Message::ResizeWindow(direction) => {
                window::latest().and_then(move |id| window::drag_resize(id, direction))
            }
            Message::MinimizeWindow => latest_window_task(|id| window::minimize(id, true)),
            Message::ToggleMaximizeWindow => latest_window_task(window::toggle_maximize),
            Message::RequestClose => window::latest().map(Message::CloseWindowResolved),
            Message::CloseWindowResolved(id) => match id {
                Some(id) => self.request_window_close(id),
                None => Task::none(),
            },
        }
    }

    pub fn view(&self) -> Element<'_, Message> {
        let content = container(column![
            self.view_titlebar(),
            row![self.view_sidebar(), self.view_document_area()].height(Length::Fill),
            self.view_statusbar(),
        ])
        .width(Length::Fill)
        .height(Length::Fill);

        stack![
            content,
            resize_handle(
                window::Direction::North,
                Length::Fill,
                5,
                alignment::Horizontal::Center,
                alignment::Vertical::Top,
                mouse::Interaction::ResizingVertically,
            ),
            resize_handle(
                window::Direction::South,
                Length::Fill,
                5,
                alignment::Horizontal::Center,
                alignment::Vertical::Bottom,
                mouse::Interaction::ResizingVertically,
            ),
            resize_handle(
                window::Direction::West,
                5,
                Length::Fill,
                alignment::Horizontal::Left,
                alignment::Vertical::Center,
                mouse::Interaction::ResizingHorizontally,
            ),
            resize_handle(
                window::Direction::East,
                5,
                Length::Fill,
                alignment::Horizontal::Right,
                alignment::Vertical::Center,
                mouse::Interaction::ResizingHorizontally,
            ),
            resize_handle(
                window::Direction::NorthWest,
                9,
                9,
                alignment::Horizontal::Left,
                alignment::Vertical::Top,
                mouse::Interaction::ResizingDiagonallyDown,
            ),
            resize_handle(
                window::Direction::NorthEast,
                9,
                9,
                alignment::Horizontal::Right,
                alignment::Vertical::Top,
                mouse::Interaction::ResizingDiagonallyUp,
            ),
            resize_handle(
                window::Direction::SouthWest,
                9,
                9,
                alignment::Horizontal::Left,
                alignment::Vertical::Bottom,
                mouse::Interaction::ResizingDiagonallyUp,
            ),
            resize_handle(
                window::Direction::SouthEast,
                9,
                9,
                alignment::Horizontal::Right,
                alignment::Vertical::Bottom,
                mouse::Interaction::ResizingDiagonallyDown,
            ),
        ]
        .width(Length::Fill)
        .height(Length::Fill)
        .into()
    }

    fn view_titlebar(&self) -> Element<'_, Message> {
        let drag_area = mouse_area(
            container(
                row![
                    text("❧").size(22),
                    text(self.title()).size(14),
                    Space::new().width(Length::Fill),
                ]
                .spacing(10)
                .align_y(Alignment::Center),
            )
            .padding([8, 12])
            .width(Length::Fill)
            .height(42),
        )
        .on_press(Message::DragWindow)
        .on_double_click(Message::ToggleMaximizeWindow);

        row![
            drag_area,
            button(text("—").size(16))
                .style(button::text)
                .on_press(Message::MinimizeWindow)
                .width(46)
                .height(42),
            button(text("□").size(15))
                .style(button::text)
                .on_press(Message::ToggleMaximizeWindow)
                .width(46)
                .height(42),
            button(text("×").size(18))
                .style(button::danger)
                .on_press(Message::RequestClose)
                .width(48)
                .height(42),
        ]
        .align_y(Alignment::Center)
        .width(Length::Fill)
        .into()
    }

    fn view_sidebar(&self) -> Element<'_, Message> {
        let workspace_style = if !self.show_settings && self.sidebar_page == SidebarPage::Workspace
        {
            button::primary
        } else {
            button::text
        };
        let history_style = if !self.show_settings && self.sidebar_page == SidebarPage::History {
            button::primary
        } else {
            button::text
        };
        let favorites_style = if !self.show_settings && self.sidebar_page == SidebarPage::Favorites
        {
            button::primary
        } else {
            button::text
        };

        let navigation = row![
            button("文档库")
                .style(workspace_style)
                .on_press(Message::SelectSidebar(SidebarPage::Workspace)),
            button("历史")
                .style(history_style)
                .on_press(Message::SelectSidebar(SidebarPage::History)),
            button("收藏")
                .style(favorites_style)
                .on_press(Message::SelectSidebar(SidebarPage::Favorites)),
            button("设置")
                .style(if self.show_settings {
                    button::primary
                } else {
                    button::text
                })
                .on_press(Message::ToggleSettings),
        ]
        .spacing(2);

        let actions = row![
            button("新建").on_press(Message::NewDocument),
            button("打开").on_press(Message::OpenFileDialog),
            button("刷新").on_press(Message::Refresh),
        ]
        .spacing(6);

        let body = if self.show_settings {
            self.view_settings()
        } else {
            match self.sidebar_page {
                SidebarPage::Workspace => self.view_workspace(),
                SidebarPage::History => self.view_archive(false),
                SidebarPage::Favorites => self.view_archive(true),
            }
        };

        container(column![navigation, actions, rule::horizontal(1), body].spacing(10))
            .padding(10)
            .width(276)
            .height(Length::Fill)
            .style(container::rounded_box)
            .into()
    }

    fn view_workspace(&self) -> Element<'_, Message> {
        let mut entries = column![].spacing(2);

        for entry in &self.workspace_entries {
            let indentation = Space::new().width((entry.depth as f32 * 13.0) + 2.0);
            if entry.is_directory() {
                entries = entries.push(
                    row![indentation, text(format!("▾  {}", entry.name)).size(13)].padding([5, 4]),
                );
            } else {
                entries = entries.push(
                    button(row![
                        indentation,
                        text(format!("◇  {}", entry.name)).size(13)
                    ])
                    .style(button::text)
                    .on_press(Message::OpenWorkspace(entry.path.clone()))
                    .width(Length::Fill),
                );
            }
        }

        if self.workspace_entries.is_empty() {
            entries = entries.push(text("文档库为空。新建或导入一个 Markdown 文档。"));
        }

        scrollable(entries).height(Length::Fill).into()
    }

    fn view_archive(&self, favorites_only: bool) -> Element<'_, Message> {
        let mut entries = column![].spacing(5);
        let mut count = 0usize;

        for entry in self
            .archive_entries
            .iter()
            .filter(|entry| !favorites_only || entry.favorite)
        {
            count += 1;
            let source = if entry.source_exists {
                "源文件存在"
            } else {
                "使用保留副本"
            };
            let open = button(
                column![text(&entry.name).size(13), text(source).size(11)]
                    .spacing(2)
                    .width(Length::Fill),
            )
            .style(button::text)
            .on_press(Message::OpenArchive(entry.id.clone()))
            .width(Length::Fill);
            let favorite = button(if entry.favorite { "★" } else { "☆" })
                .style(button::text)
                .on_press(Message::ToggleFavorite(entry.id.clone(), !entry.favorite));
            let retain = button("存入文档库")
                .style(button::text)
                .on_press(Message::SaveArchiveToWorkspace(entry.id.clone()));

            entries = entries.push(
                container(column![row![open, favorite].spacing(4), retain].spacing(2))
                    .padding(4)
                    .style(container::rounded_box),
            );
        }

        if count == 0 {
            entries = entries.push(text(if favorites_only {
                "还没有收藏文档。"
            } else {
                "还没有历史记录。打开外部 Markdown 后会在这里保留副本。"
            }));
        }

        let content = if favorites_only {
            column![entries]
        } else {
            column![
                button("清理非收藏历史")
                    .style(button::text)
                    .on_press(Message::ClearHistory),
                entries,
            ]
            .spacing(6)
        };

        scrollable(content).height(Length::Fill).into()
    }

    fn view_settings(&self) -> Element<'_, Message> {
        let workspace = self
            .storage
            .as_ref()
            .and_then(|storage| storage.lock().ok())
            .map(|storage| storage.workspace().to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("文档库不可用"));

        scrollable(
            column![
                text("原生兼容版设置").size(18),
                text("主题配色"),
                pick_list(Palette::ALL, Some(self.palette), Message::SetPalette),
                text("明暗模式"),
                pick_list(
                    Appearance::ALL,
                    Some(self.appearance),
                    Message::SetAppearance,
                ),
                rule::horizontal(1),
                text("文档库位置"),
                text(workspace).size(11),
                button("更换文档库文件夹").on_press(Message::ChooseWorkspace),
                rule::horizontal(1),
                text("本版本使用 Iced + tiny-skia 软件渲染，不包含 WebView2、Chromium、Tauri 或网页前端。")
                    .size(12),
            ]
            .spacing(10),
        )
        .height(Length::Fill)
        .into()
    }

    fn view_document_area(&self) -> Element<'_, Message> {
        let tabs = self.view_tabs();
        let body: Element<'_, Message> =
            match self.active_tab.and_then(|index| self.tabs.get(index)) {
                Some(tab) => {
                    let editor = text_editor(&tab.editor)
                        .placeholder("开始输入 Markdown…")
                        .on_action(Message::EditorAction)
                        .size(16)
                        .padding(18)
                        .height(Length::Fill);
                    let rendered =
                        markdown::view(tab.preview.items(), self.theme()).map(Message::LinkClicked);
                    let preview = scrollable(container(rendered).padding(24).width(Length::Fill))
                        .height(Length::Fill);

                    row![
                        container(editor)
                            .width(Length::FillPortion(1))
                            .height(Length::Fill)
                            .style(container::rounded_box),
                        container(preview)
                            .width(Length::FillPortion(1))
                            .height(Length::Fill)
                            .style(container::rounded_box),
                    ]
                    .spacing(4)
                    .height(Length::Fill)
                    .into()
                }
                None => container(
                    column![
                        text("一叶").size(36),
                        text("轻量、纯原生的 Markdown 编辑与实时预览"),
                        row![
                            button("新建文档").on_press(Message::NewDocument),
                            button("打开 Markdown").on_press(Message::OpenFileDialog),
                        ]
                        .spacing(8),
                    ]
                    .spacing(14)
                    .align_x(Alignment::Center),
                )
                .center(Length::Fill)
                .into(),
            };

        container(column![tabs, body].spacing(4))
            .padding([4, 6])
            .width(Length::Fill)
            .height(Length::Fill)
            .into()
    }

    fn view_tabs(&self) -> Element<'_, Message> {
        let mut tabs = row![].spacing(3).align_y(Alignment::Center);

        for (index, tab) in self.tabs.iter().enumerate() {
            let label = if tab.dirty {
                format!("{} ●", tab.title)
            } else {
                tab.title.clone()
            };
            let tab_button = button(text(label).size(13))
                .style(if self.active_tab == Some(index) {
                    button::primary
                } else {
                    button::text
                })
                .on_press(Message::ActivateTab(index));
            let close = button("×")
                .style(button::text)
                .on_press(Message::CloseTab(index));
            tabs = tabs.push(container(row![tab_button, close].spacing(1)).padding(2));
        }

        tabs = tabs.push(
            button("+")
                .style(button::text)
                .on_press(Message::NewDocument),
        );

        scrollable(tabs)
            .horizontal()
            .height(42)
            .width(Length::Fill)
            .into()
    }

    fn view_statusbar(&self) -> Element<'_, Message> {
        let document_state = self
            .active_tab
            .and_then(|index| self.tabs.get(index))
            .map(|tab| {
                let origin = match tab.origin {
                    DocumentOrigin::Workspace => "文档库",
                    DocumentOrigin::Archive => "保留副本",
                };
                if self.pending_saves.contains(&tab.key) {
                    format!("{origin} · 正在保存")
                } else if tab.dirty {
                    format!("{origin} · 尚未保存")
                } else {
                    format!("{origin} · 已保存")
                }
            })
            .unwrap_or_else(|| String::from("未打开文档"));

        container(
            row![
                text(&self.status).size(11),
                Space::new().width(Length::Fill),
                text(document_state).size(11),
                button("保存 Ctrl+S")
                    .style(button::text)
                    .on_press(Message::SaveActive),
            ]
            .spacing(8)
            .align_y(Alignment::Center),
        )
        .padding([4, 10])
        .width(Length::Fill)
        .into()
    }

    fn active_tab_mut(&mut self) -> Option<&mut DocumentTab> {
        self.active_tab.and_then(|index| self.tabs.get_mut(index))
    }

    fn with_storage_mut<T>(
        &self,
        operation: impl FnOnce(&mut NativeStorage) -> Result<T, String>,
    ) -> Result<T, String> {
        let storage = self
            .storage
            .as_ref()
            .ok_or_else(|| String::from("文档库尚未初始化"))?;
        let mut storage = storage
            .lock()
            .map_err(|_| String::from("文档库状态锁已损坏"))?;
        operation(&mut storage)
    }

    fn refresh_lists(&mut self) {
        let Some(storage) = self.storage.clone() else {
            return;
        };
        let result = storage
            .lock()
            .map_err(|_| String::from("文档库状态锁已损坏"))
            .and_then(|mut storage| {
                let workspace = storage.scan_workspace().map_err(storage_message)?;
                let archive = storage.archive_entries().map_err(storage_message)?;
                Ok((workspace, archive))
            });

        match result {
            Ok((workspace, archive)) => {
                self.workspace_entries = workspace;
                self.archive_entries = archive;
                self.status = String::from("就绪");
            }
            Err(error) => self.status = format!("刷新失败：{error}"),
        }
    }

    fn open_path(&mut self, path: &Path) {
        if !is_markdown_path(path) {
            self.status = String::from("只能打开 .md 或 .markdown 文档");
            return;
        }

        let canonical = match path.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                self.status = format!("无法打开文档：{error}");
                return;
            }
        };

        let result = self.with_storage_mut(|storage| {
            if let Ok(relative) = canonical.strip_prefix(storage.workspace()) {
                let relative = relative.to_string_lossy().replace('\\', "/");
                storage
                    .open_workspace_document(&relative)
                    .map_err(storage_message)
            } else {
                storage.import_external(&canonical).map_err(storage_message)
            }
        });
        self.handle_open_result(result);
    }

    fn handle_open_result(&mut self, result: Result<OpenedDocument, String>) {
        match result {
            Ok(document) => {
                let key = document_key(document.origin, &document.path, &document.archive_id);
                let existing_archive = if document.origin == DocumentOrigin::Archive
                    && !document.archive_id.is_empty()
                {
                    self.tabs
                        .iter()
                        .position(|tab| {
                            tab.origin == DocumentOrigin::Workspace
                                && tab.archive_id == document.archive_id
                        })
                        .or_else(|| {
                            self.tabs
                                .iter()
                                .position(|tab| tab.archive_id == document.archive_id)
                        })
                } else {
                    None
                };
                if let Some(index) =
                    existing_archive.or_else(|| self.tabs.iter().position(|tab| tab.key == key))
                {
                    self.active_tab = Some(index);
                    self.status = String::from("文档已在标签页中打开");
                    return;
                }
                self.tabs.push(DocumentTab::from_opened(document));
                self.active_tab = Some(self.tabs.len() - 1);
                self.refresh_lists();
                self.status = String::from("文档已打开；外部文件编辑保存在安全副本中");
            }
            Err(error) => self.status = format!("打开失败：{error}"),
        }
    }

    fn create_workspace_document(&mut self) {
        let occupied: HashSet<String> = self
            .workspace_entries
            .iter()
            .filter(|entry| !entry.is_directory())
            .map(|entry| entry.path.to_ascii_lowercase())
            .chain(
                self.tabs
                    .iter()
                    .filter(|tab| tab.origin == DocumentOrigin::Workspace)
                    .map(|tab| tab.path.to_ascii_lowercase()),
            )
            .collect();

        let path = (1usize..)
            .map(|number| {
                if number == 1 {
                    String::from("未命名.md")
                } else {
                    format!("未命名{number}.md")
                }
            })
            .find(|candidate| !occupied.contains(&candidate.to_ascii_lowercase()))
            .unwrap_or_else(|| format!("未命名-{}.md", self.tabs.len() + 1));

        let result = self.with_storage_mut(|storage| {
            storage
                .save_workspace_document(&path, "")
                .map_err(storage_message)?;
            storage
                .open_workspace_document(&path)
                .map_err(storage_message)
        });
        self.handle_open_result(result);
    }

    fn schedule_save(&mut self, index: usize) -> Task<Message> {
        let Some(tab) = self.tabs.get(index) else {
            return Task::none();
        };
        if !tab.dirty || self.pending_saves.contains(&tab.key) {
            return Task::none();
        }
        let Some(storage) = self.storage.clone() else {
            self.status = String::from("文档库尚未初始化");
            return Task::none();
        };

        let request = SaveRequest {
            tab_key: tab.key.clone(),
            path: tab.path.clone(),
            origin: tab.origin,
            archive_id: tab.archive_id.clone(),
            content: tab.current_content(),
        };
        self.pending_saves.insert(request.tab_key.clone());
        self.status = format!("正在后台保存 {}…", tab.title);

        Task::perform(save_document(storage, request), Message::SaveFinished)
    }

    fn finish_save(&mut self, outcome: SaveOutcome) -> Task<Message> {
        self.pending_saves.remove(&outcome.tab_key);
        let mut follow_up = Vec::new();

        match outcome.result {
            Ok(entry) => {
                let archive_id = entry.id.clone();
                if let Some(index) = self.tabs.iter().position(|tab| tab.key == outcome.tab_key) {
                    let tab = &mut self.tabs[index];
                    tab.archive_id = archive_id;
                    tab.saved_content = outcome.content;
                    tab.dirty = tab.current_content() != tab.saved_content;
                    self.status = format!("已保存 {}", tab.title);

                    if tab.dirty {
                        follow_up.push(self.schedule_save(index));
                    } else if self.pending_tab_closes.remove(&outcome.tab_key) {
                        self.remove_tab(index);
                    }
                }
                self.upsert_archive_entry(entry);
            }
            Err(error) => {
                if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.key == outcome.tab_key) {
                    tab.autosave_paused = true;
                }
                self.pending_tab_closes.remove(&outcome.tab_key);
                self.close_after_save = None;
                self.closing_window = false;
                self.status = format!(
                    "保存失败：{error}。自动保存已暂停，内容仍保留在编辑器中；请点击保存或按 Ctrl+S 重试"
                );
            }
        }

        if let Some(id) = self.close_after_save {
            let dirty: Vec<usize> = self
                .tabs
                .iter()
                .enumerate()
                .filter_map(|(index, tab)| tab.dirty.then_some(index))
                .collect();
            for index in dirty {
                follow_up.push(self.schedule_save(index));
            }

            if self.pending_saves.is_empty()
                && self.pending_archive_copies.is_empty()
                && self.tabs.iter().all(|tab| !tab.dirty)
            {
                self.close_after_save = None;
                follow_up.push(window::close(id));
            }
        }

        Task::batch(follow_up)
    }

    fn request_tab_close(&mut self, index: usize) -> Task<Message> {
        let Some(tab) = self.tabs.get(index) else {
            return Task::none();
        };
        if tab.dirty || self.pending_saves.contains(&tab.key) {
            self.pending_tab_closes.insert(tab.key.clone());
            self.schedule_save(index)
        } else {
            self.remove_tab(index);
            Task::none()
        }
    }

    fn request_window_close(&mut self, id: window::Id) -> Task<Message> {
        self.closing_window = true;
        self.close_after_save = Some(id);
        let dirty: Vec<usize> = self
            .tabs
            .iter()
            .enumerate()
            .filter_map(|(index, tab)| tab.dirty.then_some(index))
            .collect();
        let tasks: Vec<_> = dirty
            .into_iter()
            .map(|index| self.schedule_save(index))
            .collect();

        if self.pending_saves.is_empty() && self.pending_archive_copies.is_empty() {
            self.close_after_save = None;
            window::close(id)
        } else {
            self.status = String::from("正在保存未完成的更改，完成后关闭…");
            Task::batch(tasks)
        }
    }

    fn remove_tab(&mut self, index: usize) {
        if index >= self.tabs.len() {
            return;
        }
        self.tabs.remove(index);
        self.active_tab = match (self.active_tab, self.tabs.is_empty()) {
            (_, true) => None,
            (Some(active), false) if active > index => Some(active - 1),
            (Some(active), false) if active == index => Some(index.min(self.tabs.len() - 1)),
            (active, false) => active,
        };
    }

    fn upsert_archive_entry(&mut self, entry: ArchiveEntry) {
        if let Some(existing) = self
            .archive_entries
            .iter_mut()
            .find(|existing| existing.id == entry.id)
        {
            *existing = entry;
        } else {
            self.archive_entries.push(entry);
        }
        self.archive_entries
            .sort_by(|left, right| right.last_opened_ms.cmp(&left.last_opened_ms));
    }

    fn apply_settings(&mut self, value: &Value) {
        let native = value.get("nativeCompat").unwrap_or(value);
        if let Some(palette) = native
            .get("palette")
            .or_else(|| value.get("themePalette"))
            .and_then(Value::as_str)
            .and_then(Palette::from_setting)
        {
            self.palette = palette;
        }
        if let Some(appearance) = native
            .get("appearance")
            .or_else(|| value.get("themeMode"))
            .and_then(Value::as_str)
            .and_then(Appearance::from_setting)
        {
            self.appearance = appearance;
        }
    }

    fn persist_settings(&mut self) {
        let Some(storage) = self.storage.clone() else {
            return;
        };
        let result = storage
            .lock()
            .map_err(|_| String::from("文档库状态锁已损坏"))
            .and_then(|storage| {
                let mut settings = storage
                    .load_settings_value()
                    .map_err(storage_message)?
                    .unwrap_or_else(|| Value::Object(Map::new()));
                if !settings.is_object() {
                    settings = Value::Object(Map::new());
                }
                let object = settings.as_object_mut().expect("settings object");
                object.insert(
                    String::from("workspacePath"),
                    Value::String(storage.workspace().to_string_lossy().into_owned()),
                );
                object.insert(
                    String::from("nativeCompat"),
                    json!({
                        "palette": self.palette.setting(),
                        "appearance": self.appearance.setting(),
                    }),
                );
                storage
                    .save_settings_value(&settings)
                    .map_err(storage_message)
            });

        if let Err(error) = result {
            self.status = format!("设置保存失败：{error}");
        }
    }
}

fn resize_handle(
    direction: window::Direction,
    width: impl Into<Length>,
    height: impl Into<Length>,
    horizontal: alignment::Horizontal,
    vertical: alignment::Vertical,
    interaction: mouse::Interaction,
) -> Element<'static, Message> {
    container(
        mouse_area(Space::new().width(width).height(height))
            .on_press(Message::ResizeWindow(direction))
            .interaction(interaction),
    )
    .width(Length::Fill)
    .height(Length::Fill)
    .align_x(horizontal)
    .align_y(vertical)
    .into()
}

async fn save_document(storage: Arc<Mutex<NativeStorage>>, request: SaveRequest) -> SaveOutcome {
    let result = storage
        .lock()
        .map_err(|_| String::from("文档库状态锁已损坏"))
        .and_then(|mut storage| {
            match request.origin {
                DocumentOrigin::Workspace => {
                    storage.save_workspace_document(&request.path, &request.content)
                }
                DocumentOrigin::Archive => {
                    storage.save_archived(&request.archive_id, &request.content)
                }
            }
            .map_err(storage_message)
        });

    SaveOutcome {
        tab_key: request.tab_key,
        content: request.content,
        result,
    }
}

async fn save_archive_to_workspace(
    storage: Arc<Mutex<NativeStorage>>,
    id: String,
) -> (String, Result<String, String>) {
    let result = storage
        .lock()
        .map_err(|_| String::from("文档库状态锁已损坏"))
        .and_then(|mut storage| {
            storage
                .save_archived_to_workspace(&id)
                .map_err(storage_message)
        });
    (id, result)
}

fn latest_window_task(operation: fn(window::Id) -> Task<Message>) -> Task<Message> {
    window::latest().and_then(operation)
}

fn storage_message(error: StorageError) -> String {
    error.to_string()
}

fn document_key(origin: DocumentOrigin, path: &str, archive_id: &str) -> String {
    match origin {
        DocumentOrigin::Workspace => format!("workspace:{}", path.to_ascii_lowercase()),
        DocumentOrigin::Archive => format!("archive:{archive_id}"),
    }
}

fn document_title(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("未命名.md")
        .to_owned()
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

#[cfg(target_os = "windows")]
fn choose_markdown_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown"])
        .pick_file()
}

#[cfg(not(target_os = "windows"))]
fn choose_markdown_file() -> Option<PathBuf> {
    None
}

#[cfg(target_os = "windows")]
fn choose_workspace_folder() -> Option<PathBuf> {
    rfd::FileDialog::new().pick_folder()
}

#[cfg(not(target_os = "windows"))]
fn choose_workspace_folder() -> Option<PathBuf> {
    None
}
