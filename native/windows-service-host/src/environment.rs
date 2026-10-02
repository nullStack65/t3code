//! Native child environment construction.
//!
//! `CreateProcessW` given `lpEnvironment = NULL` inherits the *ambient* process
//! environment. That is wrong for this host: the selected T3 home must be the
//! child's `T3CODE_HOME`, whether the ambient value is absent or points at some
//! other home. Cwd is not a substitute — the pinned launcher reads
//! `process.env.T3CODE_HOME` directly and treats an empty value as fatal.
//!
//! This module is portable so the exact block the native spawn will pass can be
//! verified on a developer host without a Windows toolchain.

use std::ffi::OsString;
use std::path::Path;

/// Environment variable the pinned launcher requires for its base directory.
pub const HOME_KEY: &str = "T3CODE_HOME";

/// Build a Unicode environment block for `CreateProcessW`.
///
/// `ambient` is the inherited environment. Any entry whose name matches
/// [`HOME_KEY`] case-insensitively is dropped and replaced with the selected
/// `home`, so an absent ambient value is supplied and a conflicting one cannot
/// win. The result is NUL-terminated `NAME=VALUE` entries followed by a final
/// NUL, with names sorted case-insensitively as the API expects.
pub fn build_environment_block(ambient: &[(OsString, OsString)], home: &Path) -> Vec<u16> {
    let mut entries: Vec<(String, OsString)> = Vec::with_capacity(ambient.len() + 1);
    for (name, value) in ambient {
        let name = name.to_string_lossy().into_owned();
        if name.eq_ignore_ascii_case(HOME_KEY) {
            continue;
        }
        entries.push((name, value.clone()));
    }
    entries.push((HOME_KEY.to_owned(), home.as_os_str().to_os_string()));
    entries.sort_by_key(|(name, _)| name.to_ascii_lowercase());

    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(name.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.to_string_lossy().encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

/// The production launch request's environment: the host's ambient environment
/// with the selected home overriding any absent/conflicting `T3CODE_HOME`.
pub fn host_environment(home: &Path) -> Vec<u16> {
    host_environment_with(home, &[])
}

/// As [`host_environment`], also setting `extra` variables (for example the
/// per-instance control token). Each extra name replaces any ambient entry with
/// the same name case-insensitively.
pub fn host_environment_with(home: &Path, extra: &[(&str, &str)]) -> Vec<u16> {
    let mut ambient: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    for (name, value) in extra {
        ambient.retain(|(existing, _)| !existing.to_string_lossy().eq_ignore_ascii_case(name));
        ambient.push((OsString::from(name), OsString::from(value)));
    }
    build_environment_block(&ambient, home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vars(block: &[u16]) -> Vec<String> {
        let mut result = Vec::new();
        let mut current = String::new();
        for &unit in block {
            if unit == 0 {
                if !current.is_empty() {
                    result.push(std::mem::take(&mut current));
                }
            } else if let Some(character) = char::from_u32(unit as u32) {
                current.push(character);
            }
        }
        result
    }

    fn ambient(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    #[test]
    fn supplies_the_selected_home_when_absent() {
        let block = build_environment_block(
            &ambient(&[("PATH", r"C:\Windows")]),
            &PathBuf::from(r"D:\t3\.t3"),
        );
        let values = vars(&block);
        assert!(values.contains(&r"T3CODE_HOME=D:\t3\.t3".to_owned()));
        assert!(values.contains(&r"PATH=C:\Windows".to_owned()));
    }

    #[test]
    fn overrides_a_conflicting_ambient_home_case_insensitively() {
        let block = build_environment_block(
            &ambient(&[
                ("t3code_home", r"C:\Users\someone else\.t3"),
                ("PATH", r"C:\Windows"),
            ]),
            &PathBuf::from(r"D:\t3\.t3"),
        );
        let values = vars(&block);
        assert_eq!(
            values
                .iter()
                .filter(|value| value.to_ascii_lowercase().starts_with("t3code_home="))
                .count(),
            1
        );
        assert!(values.contains(&r"T3CODE_HOME=D:\t3\.t3".to_owned()));
    }

    #[test]
    fn preserves_unicode_values_and_terminates_the_block() {
        let block = build_environment_block(
            &ambient(&[("GREETING", "\u{4f60}\u{597d}")]),
            &PathBuf::from(r"D:\t3\.t3"),
        );
        assert_eq!(block.last(), Some(&0));
        let entries = vars(&block);
        assert!(
            entries
                .iter()
                .any(|value| value == "GREETING=\u{4f60}\u{597d}")
        );
    }

    #[test]
    fn sorts_names_case_insensitively() {
        let block = build_environment_block(
            &ambient(&[("zeta", "1"), ("Alpha", "2")]),
            &PathBuf::from(r"D:\t3\.t3"),
        );
        let entries = vars(&block);
        let alpha = entries
            .iter()
            .position(|value| value.starts_with("Alpha="))
            .unwrap();
        let home = entries
            .iter()
            .position(|value| value.starts_with("T3CODE_HOME="))
            .unwrap();
        let zeta = entries
            .iter()
            .position(|value| value.starts_with("zeta="))
            .unwrap();
        assert!(alpha < home && home < zeta);
    }
}
