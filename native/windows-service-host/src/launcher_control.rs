//! Private host-to-launcher control request.
//!
//! The Windows SCM host owns the launcher process. A POSIX signal cannot reach
//! a Windows process as a graceful request, and the launcher's stop marker is a
//! cleanup hint for a child mid-update, not a control channel. This module is
//! the smallest bridge that actually delivers control: the host writes a small
//! request file into the runtime directory it already owns, and the launcher
//! watches it, binds the request to its own per-instance token, consumes the
//! file and runs its real stop path.
//!
//! The JSON shape and the file name match `SERVICE_CONTROL_REQUEST_FILE`,
//! `SERVICE_LAUNCHER_INSTANCE_ENV` and `ServiceLauncherControlRequest` in
//! `apps/server/src/cloud/serviceProtocol.ts`. It is private to the service
//! home (never a public listener or a new daemon), and the instance token binds
//! a request to one launch so a stale file cannot drive a later one.

/// File name inside `<home>/runtime/`. Matches `SERVICE_CONTROL_REQUEST_FILE`.
pub const CONTROL_REQUEST_FILE: &str = ".service-control.json";
/// Child environment variable carrying the per-instance token. Matches
/// `SERVICE_LAUNCHER_INSTANCE_ENV`.
pub const INSTANCE_ENV: &str = "T3_SERVICE_LAUNCHER_INSTANCE";
/// Must match `SERVICE_LAUNCHER_PROTOCOL`; a mismatched request is ignored.
pub const CONTROL_PROTOCOL: u32 = 3;

/// Nanoseconds since the Unix epoch, or 0 if the clock is before it. Used only
/// to make an instance token unique per launch, not for any security property.
pub fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

/// A token unique to one launcher launch. The launcher only needs to bind a
/// request to one launch, so pid + monotonic clock + a counter is sufficient;
/// no randomness dependency is introduced.
pub fn instance_token(pid: u32, now_nanos: u128, sequence: u64) -> String {
    format!("{pid:x}-{now_nanos:x}-{sequence:x}")
}

/// The stop request the launcher decodes. Tokens are generated hex, so they
/// never need JSON escaping.
pub fn stop_request(instance: &str, request_id: &str) -> String {
    format!(
        "{{\"protocol\":{CONTROL_PROTOCOL},\"type\":\"stop\",\"instance\":\"{instance}\",\"requestId\":\"{request_id}\"}}"
    )
}

/// A request id unique within one launch; the launcher echoes it in its
/// acknowledgement so an acknowledgement cannot be confused with another stop.
pub fn request_id(instance: &str, sequence: u64) -> String {
    format!("{instance}-{sequence:x}")
}

/// Publish `bytes` to `target` atomically. A unique sibling temp file is
/// written and flushed, then renamed over `target`; a reader (the launcher's
/// watcher) therefore never observes a partial write, and a concurrent
/// replacement is all-or-nothing. The temp file is always cleaned up on
/// failure. Callers that need per-launch uniqueness should vary `bytes` or
/// pass distinct targets; the temp name includes the pid and a monotonic stamp.
pub fn publish_atomically(target: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("control");
    let temp = target.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        now_nanos()
    ));
    {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    match std::fs::rename(&temp, target) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_the_documented_shape() {
        let request = stop_request("abc-1-0", "abc-1-0-1");
        assert!(request.starts_with('{') && request.ends_with('}'));
        assert!(request.contains("\"protocol\":3"));
        assert!(request.contains("\"type\":\"stop\""));
        assert!(request.contains("\"instance\":\"abc-1-0\""));
        assert!(request.contains("\"requestId\":\"abc-1-0-1\""));
    }

    #[test]
    fn instance_tokens_differ_per_launch() {
        assert_ne!(instance_token(1, 100, 0), instance_token(1, 101, 0));
        assert_ne!(instance_token(1, 100, 0), instance_token(2, 100, 0));
        assert_ne!(instance_token(1, 100, 0), instance_token(1, 100, 1));
    }

    #[test]
    fn atomic_publish_replaces_in_place_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("t3-control-test-{}", now_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join(CONTROL_REQUEST_FILE);

        publish_atomically(&target, b"{\"protocol\":3}").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"protocol\":3}");
        publish_atomically(&target, b"{\"protocol\":3,\"type\":\"stop\"}").unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"{\"protocol\":3,\"type\":\"stop\"}"
        );

        // No temp siblings survive a successful publish.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() != std::ffi::OsStr::new(CONTROL_REQUEST_FILE))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_concurrent_reader_never_sees_a_partial_document() {
        use std::io::Read;

        let dir = std::env::temp_dir().join(format!("t3-control-race-{}", now_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join(CONTROL_REQUEST_FILE);
        let first =
            br#"{"protocol":3,"type":"stop","instance":"aaaaaaaa","requestId":"r-1"}"#.to_vec();
        let second =
            br#"{"protocol":3,"type":"stop","instance":"bbbbbbbb","requestId":"r-2"}"#.to_vec();
        publish_atomically(&target, &first).unwrap();

        let writer_target = target.clone();
        let writer_first = first.clone();
        let writer_second = second.clone();
        let writer = std::thread::spawn(move || {
            for index in 0..2_000 {
                let bytes = if index % 2 == 0 {
                    &writer_second
                } else {
                    &writer_first
                };
                publish_atomically(&writer_target, bytes).unwrap();
            }
        });

        let mut seen_first = 0u32;
        let mut seen_second = 0u32;
        for _ in 0..2_000 {
            if let Ok(mut file) = std::fs::File::open(&target) {
                let mut contents = Vec::new();
                if file.read_to_end(&mut contents).is_ok() {
                    // Every observation is exactly one complete document, never
                    // a prefix/suffix mix.
                    if contents == first {
                        seen_first += 1;
                    } else if contents == second {
                        seen_second += 1;
                    } else {
                        panic!("partial control document observed: {contents:?}");
                    }
                }
            }
        }
        writer.join().unwrap();
        assert!(seen_first + seen_second > 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
