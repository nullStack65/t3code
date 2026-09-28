//! Minimal T3-owned Windows SCM host.
//!
//! This crate is a prototype of the SCM entry point, control handler and
//! process-tree ownership that a real Windows background service needs. The
//! production child is the pinned `t3.exe __service-launcher` subcommand; this
//! host never re-implements the launcher's update or rollback logic.
//!
//! The SCM dispatch loop and the job-object process tree are Windows-only
//! (`windows`). The configuration parser, control mapping, restart budget and
//! stop/drain state machine are portable so they can be unit tested on any
//! developer host that has no Windows toolchain.

pub mod account;
pub mod admission;
pub mod command_line;
pub mod config;
pub mod control;
pub mod environment;
pub mod host;
pub mod launcher_control;
pub mod run;
pub mod supervise;

#[cfg(windows)]
pub mod windows;

pub use config::{Invocation, LaunchMode, ServiceConfig};
pub use control::{Control, ControlOutcome, ServiceState};
pub use host::CleanupOutcome;
pub use supervise::{ExitCode, IdentityVerdict, Supervisor, SupervisorAction};
