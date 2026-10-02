//! Child process ownership.
//!
//! The Windows service uses a job object so the whole tree the launcher starts
//! is owned and can be terminated together. The portable host exists so the
//! same supervisor can be exercised on a developer host and under `--console`;
//! it does not claim the Windows tree guarantees.

use std::fs::OpenOptions;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use crate::admission::AdmissionFailure;
use crate::config::{LaunchMode, ServiceConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// Optional process creation time in milliseconds. The Windows host uses it
    /// to tell its own child from a foreign process that reused the PID; the
    /// portable host leaves it zero.
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnError {
    /// The configuration is wrong; retrying cannot help.
    Config(String),
    /// A transient launch failure.
    Launch(String),
    /// The child was created but could not be admitted. The cleanup outcome is
    /// carried structurally so the supervisor can decide whether a retry is
    /// safe: a confirmed reclaim may retry, an unconfirmed one must not.
    Admission(AdmissionFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryError;

/// Outcome of an explicit termination attempt against an owned process tree.
///
/// `Confirmed` and `Failed` are the two outcomes of an *attempt*; `Unknown` and
/// `Refused` mean no termination was attempted at all. A bounded supervisor exit
/// must never map `Unknown`/`Refused`/`Failed` to a clean stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupOutcome {
    /// Termination was attempted and the owned process was observed to exit.
    Confirmed,
    /// Termination was attempted but not confirmed: an API call failed or the
    /// bounded wait timed out.
    Failed,
    /// Identity could not be verified, so nothing was terminated.
    Unknown,
    /// The recorded identity was verified as foreign; deliberately not terminated.
    Refused,
}

impl CleanupOutcome {
    /// A confirmed stop is the only outcome that may be reported as clean.
    pub fn is_clean(self) -> bool {
        matches!(self, CleanupOutcome::Confirmed)
    }
}

pub trait ChildHandle {
    fn identity(&self) -> ProcessIdentity;
    /// `Ok(true)` means the recorded identity is still ours, `Ok(false)` means
    /// the PID belongs to another process, and `Err` means the query failed.
    fn verify_identity(&mut self) -> Result<bool, QueryError>;
    fn try_wait(&mut self) -> Result<Option<i32>, QueryError>;
    /// Ask the launcher to stop its server child. The portable host writes the
    /// stop marker the launcher reads; the production launcher adaptation
    /// (documented in the scoped design) is what makes that marker actionable.
    fn request_graceful_stop(&mut self) -> Result<(), QueryError>;
    /// Force the owned tree down and report whether its exit was confirmed.
    fn terminate_tree(&mut self) -> CleanupOutcome;
    /// The root process has been observed to exit. Reclaim any remaining members
    /// of the owned tree through the retained handle and report whether the whole
    /// owned set is confirmed empty. The retained handle is the ownership
    /// authority, so this does not re-verify a possibly-reused PID.
    fn cleanup_after_exit(&mut self) -> CleanupOutcome;
}

pub trait ChildHost {
    type Child: ChildHandle;
    fn spawn(&mut self, config: &ServiceConfig) -> Result<Self::Child, SpawnError>;
}

/// Portable host built on `std::process::Command`.
#[derive(Debug)]
pub struct CommandChildHost {
    stop_marker: PathBuf,
}

impl CommandChildHost {
    pub fn new(config: &ServiceConfig) -> Self {
        Self {
            stop_marker: config.stop_marker(),
        }
    }
}

pub struct CommandChild {
    child: Child,
    id: ProcessIdentity,
    stop_marker: PathBuf,
}

impl ChildHost for CommandChildHost {
    type Child = CommandChild;

    fn spawn(&mut self, config: &ServiceConfig) -> Result<CommandChild, SpawnError> {
        if matches!(config.mode, LaunchMode::ServiceLauncher)
            && !std::path::Path::new(&config.home).is_dir()
        {
            return Err(SpawnError::Config(format!(
                "T3 home {} does not exist",
                config.home.display()
            )));
        }
        let (program, args) = config.child_command();
        let mut command = Command::new(&program);
        command
            .args(&args)
            .env("T3CODE_HOME", &config.home)
            .stdin(Stdio::null());
        if config.home.is_dir() {
            command.current_dir(&config.home);
        }
        if let Some(log_path) = &config.log {
            if let Some(parent) = log_path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    SpawnError::Config(format!("cannot create log directory: {error}"))
                })?;
            }
            let stdout = OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
                .map_err(|error| SpawnError::Config(format!("cannot open log file: {error}")))?;
            let stderr = stdout
                .try_clone()
                .map_err(|error| SpawnError::Config(format!("cannot clone log handle: {error}")))?;
            command
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::from(stderr));
        }
        let child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                SpawnError::Config(format!("child program not found: {}", program.display()))
            } else {
                SpawnError::Launch(format!("could not start child: {error}"))
            }
        })?;
        let id = ProcessIdentity {
            pid: child.id(),
            created_at_ms: 0,
        };
        Ok(CommandChild {
            child,
            id,
            stop_marker: self.stop_marker.clone(),
        })
    }
}

impl ChildHandle for CommandChild {
    fn identity(&self) -> ProcessIdentity {
        self.id
    }

    fn verify_identity(&mut self) -> Result<bool, QueryError> {
        // The OS handle is authoritative while it is retained; PID reuse alone
        // cannot redirect it. Creation-time comparison is Windows-only.
        match self.child.try_wait() {
            Ok(None) => Ok(true),
            Ok(Some(_)) => Ok(false),
            Err(_) => Err(QueryError),
        }
    }

    fn try_wait(&mut self) -> Result<Option<i32>, QueryError> {
        match self.child.try_wait() {
            Ok(None) => Ok(None),
            Ok(Some(status)) => Ok(Some(status.code().unwrap_or(-1))),
            Err(_) => Err(QueryError),
        }
    }

    fn request_graceful_stop(&mut self) -> Result<(), QueryError> {
        if let Some(parent) = self.stop_marker.parent() {
            std::fs::create_dir_all(parent).map_err(|_| QueryError)?;
        }
        std::fs::write(&self.stop_marker, b"").map_err(|_| QueryError)
    }

    fn terminate_tree(&mut self) -> CleanupOutcome {
        // Kill first; the subsequent wait both reaps the child and confirms the
        // exit. A failed kill of an already-exiting child still confirms via wait.
        let _ = self.child.kill();
        match self.child.wait() {
            Ok(_) => CleanupOutcome::Confirmed,
            Err(_) => CleanupOutcome::Failed,
        }
    }

    fn cleanup_after_exit(&mut self) -> CleanupOutcome {
        // `try_wait` already reaped the root. The portable host has no job object
        // to observe for grandchildren, so a reaped root is the limit of what it
        // can confirm; it never claims more than that.
        match self.child.try_wait() {
            Ok(Some(_)) => CleanupOutcome::Confirmed,
            // Called only after the root was observed to exit; still running is
            // not something this host can call confirmed-empty.
            Ok(None) => CleanupOutcome::Unknown,
            Err(_) => CleanupOutcome::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DEFAULT_DRAIN_TIMEOUT, LaunchMode, ServiceConfig};
    use std::time::Duration;

    fn config() -> ServiceConfig {
        ServiceConfig {
            home: PathBuf::from("."),
            runtime: PathBuf::new(),
            log: None,
            service_name: "t3code".to_owned(),
            drain_timeout: DEFAULT_DRAIN_TIMEOUT,
            restart_window: Duration::from_secs(300),
            max_restarts: 3,
            poll_interval: Duration::from_millis(50),
            expected_account: None,
            allow_local_system: false,
            mode: LaunchMode::ServiceLauncher,
        }
    }

    #[test]
    fn rejects_a_missing_home_for_the_service_launcher() {
        let mut host = CommandChildHost {
            stop_marker: PathBuf::from(".t3-test-stop-marker"),
        };
        let scoped = ServiceConfig {
            home: PathBuf::from("does-not-exist-t3-home"),
            ..config()
        };
        assert!(matches!(
            host.spawn(&scoped),
            Err(SpawnError::Config(message)) if message.contains("does not exist")
        ));
    }
}
