//! Windows command-line construction for the launched child.
//!
//! `CreateProcessW` receives a single command-line string, not an argv array, so
//! the host must apply the Windows quoting rules itself. The pinned launcher is
//! passed as `"<runtime>" "__service-launcher"`, and paths may contain spaces or
//! Unicode. Keeping this portable lets the exact production launch request be
//! asserted on a developer host without a Windows toolchain.

/// Build a NUL-terminated command line from a UTF-16 program and arguments.
pub fn build_command_line(program: &[u16], args: &[Vec<u16>]) -> Vec<u16> {
    let mut line = Vec::new();
    push_quoted(&mut line, program);
    for arg in args {
        line.push(u16::from(b' '));
        push_quoted(&mut line, arg);
    }
    line.push(0);
    line
}

/// Quote one argument: backslashes are doubled before a closing quote, and a
/// literal quote is escaped as `2n + 1` backslashes followed by the quote.
fn push_quoted(out: &mut Vec<u16>, value: &[u16]) {
    out.push(u16::from(b'"'));
    let mut backslashes = 0usize;
    for &character in value {
        if character == u16::from(b'\\') {
            backslashes += 1;
            out.push(character);
        } else if character == u16::from(b'"') {
            for _ in 0..backslashes + 1 {
                out.push(u16::from(b'\\'));
            }
            out.push(character);
            backslashes = 0;
        } else {
            backslashes = 0;
            out.push(character);
        }
    }
    for _ in 0..backslashes {
        out.push(u16::from(b'\\'));
    }
    out.push(u16::from(b'"'));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    fn render(line: &[u16]) -> String {
        String::from_utf16_lossy(&line[..line.len() - 1])
    }

    #[test]
    fn quotes_the_program_and_launcher_subcommand() {
        let line = build_command_line(&utf16(r"C:\t3\t3.exe"), &[utf16("__service-launcher")]);
        assert_eq!(render(&line), r#""C:\t3\t3.exe" "__service-launcher""#);
        assert_eq!(line.last(), Some(&0));
    }

    #[test]
    fn keeps_spaces_inside_one_argument() {
        let line = build_command_line(&utf16(r"C:\Program Files\t3\t3.exe"), &[]);
        assert_eq!(render(&line), r#""C:\Program Files\t3\t3.exe""#);
    }

    #[test]
    fn doubles_trailing_backslashes_before_the_closing_quote() {
        let line = build_command_line(&utf16(r"C:\t3\"), &[]);
        assert_eq!(render(&line), r#""C:\t3\\""#);
    }

    #[test]
    fn escapes_embedded_quotes() {
        let line = build_command_line(&utf16("a\"b"), &[]);
        assert_eq!(render(&line), r#""a\"b""#);
    }

    #[test]
    fn preserves_unicode_arguments() {
        let line = build_command_line(&utf16("t3.exe"), &[utf16("\u{4f60}\u{597d}")]);
        assert_eq!(render(&line), "\"t3.exe\" \"\u{4f60}\u{597d}\"");
    }
}
