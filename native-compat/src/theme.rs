use iced::{theme, Color, Theme as IcedTheme};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Palette {
    Leaf,
    Sakura,
    Qingchuan,
    Monochrome,
}

impl Palette {
    pub const ALL: [Self; 4] = [Self::Leaf, Self::Sakura, Self::Qingchuan, Self::Monochrome];

    pub fn label(self) -> &'static str {
        match self {
            Self::Leaf => "一叶绿",
            Self::Sakura => "樱花粉",
            Self::Qingchuan => "清川蓝",
            Self::Monochrome => "黑白灰",
        }
    }

    pub fn from_setting(value: &str) -> Option<Self> {
        match value {
            "leaf" | "leaf-green" => Some(Self::Leaf),
            "sakura" | "sakura-pink" => Some(Self::Sakura),
            "qingchuan" | "qingchuan-blue" => Some(Self::Qingchuan),
            "monochrome" | "black-white-gray" => Some(Self::Monochrome),
            _ => None,
        }
    }

    pub fn setting(self) -> &'static str {
        match self {
            Self::Leaf => "leaf",
            Self::Sakura => "sakura",
            Self::Qingchuan => "qingchuan",
            Self::Monochrome => "monochrome",
        }
    }
}

impl fmt::Display for Palette {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
}

impl Appearance {
    pub const ALL: [Self; 2] = [Self::Light, Self::Dark];

    pub fn label(self) -> &'static str {
        match self {
            Self::Light => "浅色",
            Self::Dark => "深色",
        }
    }

    pub fn from_setting(value: &str) -> Option<Self> {
        match value {
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }

    pub fn setting(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

impl fmt::Display for Appearance {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Colors {
    pub background: Color,
    pub panel: Color,
    pub panel_alt: Color,
    pub text: Color,
    pub muted: Color,
    pub accent: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
}

pub fn iced_theme(palette: Palette, appearance: Appearance) -> IcedTheme {
    let colors = colors(palette, appearance);
    IcedTheme::custom(
        format!("leafmark-{}-{}", palette.setting(), appearance.setting()),
        theme::Palette {
            background: colors.background,
            text: colors.text,
            primary: colors.accent,
            success: colors.success,
            warning: colors.warning,
            danger: colors.danger,
        },
    )
}

pub fn colors(palette: Palette, appearance: Appearance) -> Colors {
    match (palette, appearance) {
        (Palette::Leaf, Appearance::Light) => Colors {
            background: rgb(249, 251, 249),
            panel: rgb(255, 255, 255),
            panel_alt: rgb(241, 246, 243),
            text: rgb(34, 49, 41),
            muted: rgb(103, 121, 111),
            accent: rgb(44, 122, 83),
            success: rgb(55, 142, 92),
            warning: rgb(184, 130, 41),
            danger: rgb(190, 66, 66),
        },
        (Palette::Leaf, Appearance::Dark) => Colors {
            background: rgb(19, 25, 22),
            panel: rgb(25, 33, 29),
            panel_alt: rgb(31, 43, 36),
            text: rgb(226, 235, 229),
            muted: rgb(153, 173, 161),
            accent: rgb(104, 190, 139),
            success: rgb(104, 190, 139),
            warning: rgb(227, 179, 83),
            danger: rgb(236, 124, 124),
        },
        (Palette::Sakura, Appearance::Light) => Colors {
            background: rgb(255, 250, 252),
            panel: rgb(255, 255, 255),
            panel_alt: rgb(250, 241, 245),
            text: rgb(72, 43, 54),
            muted: rgb(132, 98, 111),
            accent: rgb(191, 87, 123),
            success: rgb(74, 139, 103),
            warning: rgb(190, 133, 43),
            danger: rgb(190, 62, 71),
        },
        (Palette::Sakura, Appearance::Dark) => Colors {
            background: rgb(29, 21, 25),
            panel: rgb(38, 27, 32),
            panel_alt: rgb(48, 32, 39),
            text: rgb(244, 229, 235),
            muted: rgb(193, 158, 171),
            accent: rgb(236, 143, 174),
            success: rgb(116, 188, 143),
            warning: rgb(232, 183, 87),
            danger: rgb(244, 124, 132),
        },
        (Palette::Qingchuan, Appearance::Light) => Colors {
            background: rgb(248, 252, 254),
            panel: rgb(255, 255, 255),
            panel_alt: rgb(238, 246, 250),
            text: rgb(34, 50, 61),
            muted: rgb(93, 116, 130),
            accent: rgb(42, 109, 155),
            success: rgb(54, 137, 104),
            warning: rgb(183, 128, 38),
            danger: rgb(190, 66, 66),
        },
        (Palette::Qingchuan, Appearance::Dark) => Colors {
            background: rgb(17, 24, 29),
            panel: rgb(23, 32, 38),
            panel_alt: rgb(28, 42, 51),
            text: rgb(224, 235, 241),
            muted: rgb(144, 169, 183),
            accent: rgb(105, 179, 224),
            success: rgb(104, 188, 143),
            warning: rgb(226, 178, 83),
            danger: rgb(236, 124, 124),
        },
        (Palette::Monochrome, Appearance::Light) => Colors {
            background: rgb(247, 247, 248),
            panel: rgb(255, 255, 255),
            panel_alt: rgb(239, 240, 242),
            text: rgb(30, 32, 35),
            muted: rgb(103, 106, 112),
            accent: rgb(45, 48, 52),
            success: rgb(78, 126, 93),
            warning: rgb(153, 112, 44),
            danger: rgb(177, 51, 51),
        },
        (Palette::Monochrome, Appearance::Dark) => Colors {
            background: rgb(18, 19, 21),
            panel: rgb(25, 26, 29),
            panel_alt: rgb(34, 36, 39),
            text: rgb(234, 235, 237),
            muted: rgb(160, 163, 169),
            accent: rgb(225, 227, 230),
            success: rgb(133, 185, 149),
            warning: rgb(220, 177, 92),
            danger: rgb(235, 117, 117),
        },
    }
}

const fn rgb(red: u8, green: u8, blue: u8) -> Color {
    Color::from_rgb8(red, green, blue)
}
