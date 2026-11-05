//! Display the original webpage logo as an inline image, never as character art.
use ratatui::{
    layout::{Rect, Size},
    Frame,
};
use ratatui_image::{
    picker::{Picker, ProtocolType},
    protocol::Protocol,
    FontSize, Image, Resize,
};

pub struct Logo(Protocol);

impl Logo {
    pub fn from_terminal() -> Option<Self> {
        let picker = detect()?;
        let image = image::load_from_memory(include_bytes!(
            "../../src/assets/brands/krab-kata-hybrid.png"
        ))
        .ok()?;
        let font = picker.font_size();
        let width = u32::from(font.width) * 6;
        let height = u32::from(font.height) * 3;
        let mark = image.resize(width, height, image::imageops::FilterType::Lanczos3);
        let mut canvas = image::RgbaImage::new(width, height);
        image::imageops::overlay(
            &mut canvas,
            &mark.to_rgba8(),
            i64::from((width - mark.width()) / 2),
            i64::from((height - mark.height()) / 2),
        );
        let mut protocol = picker
            .new_protocol(
                image::DynamicImage::ImageRgba8(canvas),
                Size::new(6, 3),
                Resize::Fit(None),
            )
            .ok()?;
        if let Protocol::ITerm2(inline) = &mut protocol {
            // Pixel units are device pixels on Retina displays, whereas the
            // reported font size can be in points. Let iTerm2 map cells itself.
            // The name is base64("krab-logo.png"), used in iTerm2's display prompt.
            inline.data = inline
                .data
                .replace(
                    &format!(";width={width}px;height={height}px;"),
                    ";width=6;height=3;",
                )
                .replacen(
                    "File=inline=1;",
                    "File=inline=1;name=a3JhYi1sb2dvLnBuZw==;",
                    1,
                );
        }
        Some(Self(protocol))
    }

    pub fn render(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Image::new(&self.0), area);
    }
}

#[cfg(unix)]
fn detect() -> Option<Picker> {
    use ratatui_image::picker::cap_parser::{Parser, QueryStdioOptions, Response};
    use rustix::event::{poll, PollFd, PollFlags};
    use std::{
        fs::OpenOptions,
        io::{Read, Write},
        time::{Duration, Instant},
    };

    // Query the controlling terminal directly: stdout must remain clean for
    // `krab edit --output -`. No background reader may compete with keyboard input.
    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .ok()?;
    let tmux = std::env::var("TMUX").is_ok();
    // iTerm2 can acknowledge Kitty graphics without implementing the Unicode
    // placeholders used by ratatui-image. Ask its identity before selecting a
    // protocol, including over Lima/SSH where TERM_PROGRAM may be missing.
    let (start, escape, end) = Parser::tmux_start_escape_end(tmux);
    write!(tty, "{start}{escape}[>q{end}").ok()?;
    tty.write_all(Parser::query(tmux, QueryStdioOptions::default()).as_bytes())
        .ok()?;
    tty.flush().ok()?;
    let deadline = Instant::now() + Duration::from_millis(300);
    let mut parser = Parser::new();
    let mut protocol = None;
    let mut font_size = None;
    let mut replies = String::new();
    'query: while Instant::now() < deadline {
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as i32;
        let mut fds = [PollFd::new(&tty, PollFlags::IN)];
        if poll(&mut fds, timeout).ok()? == 0 {
            break;
        }
        let mut bytes = [0; 256];
        let count = tty.read(&mut bytes).ok()?;
        if count == 0 {
            break;
        }
        for byte in &bytes[..count] {
            replies.push(char::from(*byte));
            for response in parser.push(char::from(*byte)) {
                match response {
                    Response::Kitty => protocol = Some(ProtocolType::Kitty),
                    Response::Sixel if protocol.is_none() => protocol = Some(ProtocolType::Sixel),
                    Response::CellSize(Some((width, height))) => {
                        font_size = Some(FontSize::new(width, height))
                    }
                    Response::Status => break 'query,
                    _ => {}
                }
            }
        }
    }
    let font_size = font_size.or_else(|| {
        let size = rustix::termios::tcgetwinsize(&tty).ok()?;
        if size.ws_col == 0 || size.ws_row == 0 {
            return None;
        }
        let width = size.ws_xpixel / size.ws_col;
        let height = size.ws_ypixel / size.ws_row;
        (width > 0 && height > 0).then_some(FontSize::new(width, height))
    })?;
    // The stdio constructor writes queries to stdout and spawns a reader. Supply
    // the font size from our bounded /dev/tty query instead.
    #[allow(deprecated)]
    let mut picker = Picker::from_fontsize(font_size);
    if replies.contains("\x1bP>|iTerm2 ") || picker.protocol_type() == ProtocolType::Iterm2 {
        picker.set_protocol_type(ProtocolType::Iterm2);
    } else if let Some(protocol) = protocol {
        picker.set_protocol_type(protocol);
    }
    (picker.protocol_type() != ProtocolType::Halfblocks).then_some(picker)
}

#[cfg(not(unix))]
fn detect() -> Option<Picker> {
    None
}
