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
}
