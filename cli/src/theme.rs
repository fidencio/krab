//! Presentation-only mapping of validated product palettes to terminal styles.
use ratatui::{
    style::{Color, Modifier, Style},
    text::Line,
    widgets::Block,
    Frame,
};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Light,
    Dark,
}

impl Mode {
    pub fn terminal(background: Option<(u8, u8, u8)>) -> Result<Self, String> {
        Self::select(
            std::env::var("KRAB_THEME").ok().as_deref(),
            background,
            std::env::var("COLORFGBG").ok().as_deref(),
        )
    }

    fn select(
        override_mode: Option<&str>,
        background: Option<(u8, u8, u8)>,
        colorfgbg: Option<&str>,
    ) -> Result<Self, String> {
        match override_mode {
            Some("light") => return Ok(Self::Light),
            Some("dark") => return Ok(Self::Dark),
            None | Some("auto") => {}
            _ => return Err("KRAB_THEME must be auto, light, or dark".into()),
        }
        let light = background.map_or_else(
            || {
                matches!(
                    colorfgbg.and_then(|s| s.rsplit(';').next()),
                    Some("7" | "15")
                )
            },
            |(r, g, b)| luminance(r, g, b) > 0.179,
        );
        Ok(if light { Self::Light } else { Self::Dark })
    }
}

#[derive(Clone, Copy)]
pub struct Theme {
    pub page: Style,
    pub panel: Style,
    pub border: Style,
    pub muted: Style,
    pub subtle: Style,
    pub heading: Style,
    pub selection: Style,
    pub check_selection: Style,
    pub success: Style,
    pub warning: Style,
}

impl Theme {
    pub fn from_catalog(catalog: &Value, mode: Mode) -> Self {
        let palette = &catalog["product"]["theme"][match mode {
            Mode::Light => "light",
            Mode::Dark => "dark",
        }];
        let apply = |style: Style, field: &str, background: bool| {
            color(&palette[field]).map_or(style, |color| {
                if background {
                    style.bg(color)
                } else {
                    style.fg(color)
                }
            })
        };
        let page = apply(
            apply(Style::default(), "text", false),
            "pageBackground",
            true,
        );
        let panel = apply(page, "panelBackground", true);
        let selection = color(&palette["accent"]).map_or_else(
            || Style::default().fg(Color::Black).bg(Color::Cyan),
            |accent| {
                let Color::Rgb(r, g, b) = accent else {
                    unreachable!()
                };
                let foreground = if luminance(r, g, b) > 0.179 {
                    Color::Black
                } else {
                    Color::White
                };
                Style::default().fg(foreground).bg(accent)
            },
        );
        let status = color(&palette["accent"]).or_else(|| color(&palette["text"]));
        Self {
            success: status.map_or(Style::default().fg(Color::Green), |c| {
                Style::default().fg(c)
            }),
            warning: status.map_or(Style::default().fg(Color::Yellow), |c| {
                Style::default().fg(c).add_modifier(Modifier::BOLD)
            }),
            page,
            panel,
            border: apply(Style::default(), "border", false),
            muted: apply(Style::default().fg(Color::DarkGray), "mutedText", false),
            subtle: apply(Style::default(), "mutedText", false),
            heading: apply(
                Style::default().fg(Color::Rgb(252, 94, 51)),
                "accent",
                false,
            )
            .add_modifier(Modifier::BOLD),
            selection: selection.add_modifier(Modifier::BOLD),
            check_selection: if color(&palette["accent"]).is_some() {
                selection
            } else {
                Style::default().fg(Color::Cyan)
            },
        }
    }

    pub fn paint(&self, frame: &mut Frame<'_>) {
        frame.render_widget(Block::default().style(self.page), frame.area());
    }

    pub fn block<'a>(&self, title: impl Into<Line<'a>>) -> Block<'a> {
        Block::bordered()
            .title(title.into())
            .style(self.panel)
            .border_style(self.border)
            .title_style(self.panel)
    }
}

fn color(value: &Value) -> Option<Color> {
    let hex = value.as_str()?.strip_prefix('#')?;
    let number = u32::from_str_radix(hex, 16).ok()?;
    let (r, g, b) = match hex.len() {
        3 => (
            ((number >> 8) & 15) * 17,
            ((number >> 4) & 15) * 17,
            (number & 15) * 17,
        ),
        6 => ((number >> 16) & 255, (number >> 8) & 255, number & 255),
        _ => return None,
    };
    Some(Color::Rgb(r as u8, g as u8, b as u8))
}

fn luminance(r: u8, g: u8, b: u8) -> f64 {
    let linear = |value: u8| {
        let c = f64::from(value) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terminal_mode_prefers_override_then_reported_background_then_environment() {
        assert_eq!(
            Mode::select(Some("light"), Some((0, 0, 0)), None).unwrap(),
            Mode::Light
        );
        assert_eq!(
            Mode::select(Some("dark"), Some((255, 255, 255)), None).unwrap(),
            Mode::Dark
        );
        assert_eq!(
            Mode::select(Some("auto"), Some((255, 255, 255)), Some("15;0")).unwrap(),
            Mode::Light
        );
        assert_eq!(
            Mode::select(None, Some((0, 0, 0)), Some("0;15")).unwrap(),
            Mode::Dark
        );
        assert_eq!(Mode::select(None, None, Some("0;15")).unwrap(), Mode::Light);
        assert_eq!(Mode::select(None, None, Some("15;0")).unwrap(), Mode::Dark);
        assert_eq!(Mode::select(None, None, None).unwrap(), Mode::Dark);
        assert!(Mode::select(Some("invalid"), None, None).is_err());
    }

    #[test]
    fn partial_palettes_preserve_defaults_and_selection_uses_readable_contrast() {
        let baseline = Theme::from_catalog(&json!({}), Mode::Dark);
        assert_eq!(baseline.page, Style::default());
        assert_eq!(baseline.success.fg, Some(Color::Green));
        assert_eq!(baseline.warning.fg, Some(Color::Yellow));
        assert_eq!(baseline.heading.fg, Some(Color::Rgb(252, 94, 51)));
        assert_eq!(baseline.selection.bg, Some(Color::Cyan));
        assert_eq!(baseline.check_selection.fg, Some(Color::Cyan));
        let catalog =
            json!({"product":{"theme":{"dark":{"accent":"#fff"},"light":{"accent":"#123"}}}});
        let dark = Theme::from_catalog(&catalog, Mode::Dark);
        assert_eq!(dark.selection.fg, Some(Color::Black));
        assert_eq!(dark.selection.bg, Some(Color::Rgb(255, 255, 255)));
        assert_eq!(dark.page, baseline.page);
        let light = Theme::from_catalog(&catalog, Mode::Light);
        assert_eq!(light.selection.fg, Some(Color::White));
        assert_eq!(light.selection.bg, Some(Color::Rgb(17, 34, 51)));
    }
}
