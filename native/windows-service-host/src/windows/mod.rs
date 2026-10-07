//! Windows-only pieces: the job-object child host and the SCM service loop.
//!
//! The portable core in the crate root has no Windows dependency; this module
//! is compiled only when targeting Windows so the crate can be unit tested on
//! a developer host.

pub mod job;
pub mod service;

pub use service::run_service;
