//! Portable supervision state machine.
//!
//! The Windows layer owns the SCM status handle and the job object. This module
//! owns the decisions: when to spawn, when an exit is unexpected, when the
//! restart budget is exhausted, and when a stop has drained or must be forced.
//! Keeping it free of OS calls makes the focused cases deterministic.
//!
//! Two rules are encoded here:
//!
//! - A stop request changes the state to `StopPending` and asks the launcher to
//!   stop, but the process tree is only force-terminated after the drain
//!   deadline. A query failure is never treated as proof that the child
//!   stopped; the runner verifies identity before it acts.
//! - The restart budget is bounded. After `max_restarts` restarts inside
//!   `restart_window`, the next unexpected exit stops the service instead of
//!   respawning forever.

use std::collections::VecDeque;
use std::time::Duration;

use crate::config::ServiceConfig;
use crate::control::{Control, ControlOutcome, ServiceState, handle_control};
use crate::host::{CleanupOutcome, ProcessIdentity, QueryError};

/// Monotonic time since the host started.
pub type Monotonic = Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCode {
    /// A planned stop completed.
    Clean,
    /// The child exited on its own with this code.
    Child(i32),
    /// The restart budget was exhausted.
    RepeatedFailure,
    /// The child could not be spawned at all.
    LaunchFailure,
    /// The cause could not be established.
    Unknown,
}

impl ExitCode {
    /// `(dwWin32ExitCode, dwServiceSpecificExitCode)` for `SetServiceStatus`.
    pub fn win32(self) -> (u32, u32) {
        // ERROR_SERVICE_SPECIFIC_ERROR tells SCM to read the specific code.
        const ERROR_SERVICE_SPECIFIC_ERROR: u32 = 1066;
        match self {
            ExitCode::Clean => (0, 0),
            ExitCode::Child(_) => (ERROR_SERVICE_SPECIFIC_ERROR, 1),
            ExitCode::RepeatedFailure => (ERROR_SERVICE_SPECIFIC_ERROR, 2),
            ExitCode::LaunchFailure => (ERROR_SERVICE_SPECIFIC_ERROR, 3),
            ExitCode::Unknown => (ERROR_SERVICE_SPECIFIC_ERROR, 4),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityVerdict {
    /// The recorded identity is still the process this host spawned.
    Owned,
    /// The PID now belongs to another process.
    Foreign,
    /// The query failed; ownership is unknown.
    Unknown,
}

/// Map a `verify_identity` result. `Err` means the query failed and must not be
/// read as either ownership or a successful stop.
pub fn identity_verdict(result: Result<bool, QueryError>) -> IdentityVerdict {
    match result {
        Ok(true) => IdentityVerdict::Owned,
        Ok(false) => IdentityVerdict::Foreign,
        Err(QueryError) => IdentityVerdict::Unknown,
    }
}

/// Only a verified-owned process tree may be terminated. This is what keeps the
/// host from cleaning up a foreign process that reused a stale PID.
pub fn may_cleanup(verdict: IdentityVerdict) -> bool {
    matches!(verdict, IdentityVerdict::Owned)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorAction {
    SpawnChild,
    Report { state: ServiceState, exit: ExitCode },
    RequestGracefulStop,
    ForceTerminateTree,
}

#[derive(Debug)]
pub struct Supervisor {
    config: ServiceConfig,
    state: ServiceState,
    identity: Option<ProcessIdentity>,
    restart_times: VecDeque<Monotonic>,
    stop_requested_at: Option<Monotonic>,
    terminate_issued: bool,
    checkpoint: u32,
    last_exit: ExitCode,
    finished: bool,
    forced: bool,
}

impl Supervisor {
    pub fn new(config: ServiceConfig) -> Self {
        Self {
            config,
            state: ServiceState::Stopped,
            identity: None,
            restart_times: VecDeque::new(),
            stop_requested_at: None,
            terminate_issued: false,
            checkpoint: 0,
            last_exit: ExitCode::Clean,
            finished: false,
            forced: false,
        }
    }

    pub fn state(&self) -> ServiceState {
        self.state
    }

    pub fn exit_code(&self) -> ExitCode {
        self.last_exit
    }

    pub fn checkpoint(&self) -> u32 {
        self.checkpoint
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn forced(&self) -> bool {
        self.forced
    }

    pub fn child_identity(&self) -> Option<ProcessIdentity> {
        self.identity
    }

    /// Begin service startup: report pending, then ask the runner to spawn.
    pub fn begin(&mut self, _now: Monotonic) -> Vec<SupervisorAction> {
        self.state = ServiceState::StartPending;
        vec![
            SupervisorAction::Report {
                state: ServiceState::StartPending,
                exit: ExitCode::Clean,
            },
            SupervisorAction::SpawnChild,
        ]
    }

    /// The child started. The real SCM is still `START_PENDING` at this point:
    /// the internal state change is not enough, so this returns the actual
    /// `RUNNING` report the runner must publish. Without it the SCM never advertises
    /// STOP/SHUTDOWN controls.
    pub fn on_child_spawned(&mut self, identity: ProcessIdentity) -> Vec<SupervisorAction> {
        self.identity = Some(identity);
        self.state = ServiceState::Running;
        vec![SupervisorAction::Report {
            state: ServiceState::Running,
            exit: ExitCode::Clean,
        }]
    }

    /// The runner could not spawn the child. `fatal` marks a configuration
    /// error that a retry cannot fix.
    pub fn on_spawn_failed(&mut self, now: Monotonic, fatal: bool) -> Vec<SupervisorAction> {
        self.identity = None;
        if fatal || !self.try_restart(now) {
            let code = if fatal {
                ExitCode::LaunchFailure
            } else {
                ExitCode::RepeatedFailure
            };
            return self.finish(code);
        }
        vec![
            SupervisorAction::Report {
                state: ServiceState::StartPending,
                exit: ExitCode::Clean,
            },
            SupervisorAction::SpawnChild,
        ]
    }

    /// The child exited. A `StopPending` exit is the planned stop completing;
    /// anything else is unexpected and consumes the restart budget.
    pub fn on_child_exited(&mut self, now: Monotonic, _code: i32) -> Vec<SupervisorAction> {
        self.identity = None;
        if matches!(self.state, ServiceState::StopPending) {
            return self.finish(ExitCode::Clean);
        }
        if self.try_restart(now) {
            self.state = ServiceState::StartPending;
            return vec![
                SupervisorAction::Report {
                    state: ServiceState::StartPending,
                    exit: ExitCode::Clean,
                },
                SupervisorAction::SpawnChild,
            ];
        }
        self.finish(ExitCode::RepeatedFailure)
    }

    /// Feed an SCM control. Stop and shutdown are the only controls that
    /// change state, and they are idempotent.
    pub fn on_control(&mut self, now: Monotonic, control: Control) -> Vec<SupervisorAction> {
        match handle_control(self.state, control) {
            ControlOutcome::StopRequested => {
                self.state = ServiceState::StopPending;
                self.stop_requested_at = Some(now);
                vec![
                    SupervisorAction::Report {
                        state: ServiceState::StopPending,
                        exit: ExitCode::Clean,
                    },
                    SupervisorAction::RequestGracefulStop,
                ]
            }
            ControlOutcome::AlreadyStopping
            | ControlOutcome::Interrogated
            | ControlOutcome::Ignored => Vec::new(),
        }
    }

    /// Periodic heartbeat. While stopping, refresh the SCM checkpoint until the
    /// drain deadline, then force the tree down exactly once.
    pub fn tick(&mut self, now: Monotonic) -> Vec<SupervisorAction> {
        if !matches!(self.state, ServiceState::StopPending) {
            return Vec::new();
        }
        if self.identity.is_some()
            && !self.terminate_issued
            && self
                .stop_requested_at
                .is_some_and(|since| now.saturating_sub(since) >= self.config.drain_timeout)
        {
            self.terminate_issued = true;
            self.forced = true;
            return vec![SupervisorAction::ForceTerminateTree];
        }
        self.checkpoint = self.checkpoint.wrapping_add(1);
        vec![SupervisorAction::Report {
            state: ServiceState::StopPending,
            exit: ExitCode::Clean,
        }]
    }

    /// After a forced termination the runner has no exit event to feed. Finish the
    /// stop, but only claim a clean shutdown when the cleanup was confirmed.
    /// `Failed`, `Unknown` and `Refused` are a bounded exit without evidence, not
    /// a clean stop.
    pub fn on_forced_termination(&mut self, cleanup: CleanupOutcome) -> Vec<SupervisorAction> {
        self.identity = None;
        let code = if cleanup.is_clean() {
            ExitCode::Clean
        } else {
            ExitCode::Unknown
        };
        self.finish(code)
    }

    /// A status publication failed, so the SCM no longer knows the true state.
    /// Finish with an unknown cause: even a confirmed child cleanup is not a
    /// clean service stop when the SCM was never told the service was running.
    pub fn on_publish_failure(&mut self) -> Vec<SupervisorAction> {
        self.identity = None;
        self.finish(ExitCode::Unknown)
    }

    fn try_restart(&mut self, now: Monotonic) -> bool {
        self.restart_times
            .retain(|started| now.saturating_sub(*started) < self.config.restart_window);
        if self.restart_times.len() as u32 >= self.config.max_restarts {
            return false;
        }
        self.restart_times.push_back(now);
        true
    }

    fn finish(&mut self, code: ExitCode) -> Vec<SupervisorAction> {
        self.state = ServiceState::Stopped;
        self.last_exit = code;
        self.identity = None;
        self.finished = true;
        vec![SupervisorAction::Report {
            state: ServiceState::Stopped,
            exit: code,
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DEFAULT_DRAIN_TIMEOUT, LaunchMode, ServiceConfig};
    use std::path::PathBuf;

    fn config() -> ServiceConfig {
        ServiceConfig {
            home: PathBuf::from(r"C:\Users\t3service\.t3"),
            runtime: PathBuf::from(r"C:\Users\t3service\.t3\runtime\versions\0.0.42\t3.exe"),
            log: None,
            service_name: "t3code".to_owned(),
            drain_timeout: Duration::from_secs(30),
            restart_window: Duration::from_secs(300),
            max_restarts: 3,
            poll_interval: Duration::from_millis(200),
            expected_account: None,
            allow_local_system: false,
            mode: LaunchMode::ServiceLauncher,
        }
    }

    fn identity(pid: u32) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            created_at_ms: 1_000,
        }
    }

    fn ms(value: u64) -> Monotonic {
        Duration::from_millis(value)
    }

    fn spawn_count(actions: &[SupervisorAction]) -> usize {
        actions
            .iter()
            .filter(|action| matches!(action, SupervisorAction::SpawnChild))
            .count()
    }

    fn reported(actions: &[SupervisorAction], state: ServiceState) -> bool {
        actions.iter().any(|action| {
            matches!(
                action,
                SupervisorAction::Report { state: found, .. } if *found == state
            )
        })
    }

    #[test]
    fn start_reports_pending_then_runs() {
        let mut supervisor = Supervisor::new(config());
        let actions = supervisor.begin(ms(0));
        assert!(reported(&actions, ServiceState::StartPending));
        assert_eq!(spawn_count(&actions), 1);

        let actions = supervisor.on_child_spawned(identity(42));
        assert_eq!(supervisor.state(), ServiceState::Running);
        assert!(supervisor.child_identity().is_some());
        assert!(
            reported(&actions, ServiceState::Running),
            "a successful spawn must publish the RUNNING transition"
        );
    }

    #[test]
    fn restart_publishes_running_again() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));
        supervisor.on_child_exited(ms(1_000), 7); // unexpected, budget allows restart
        let actions = supervisor.on_child_spawned(identity(43));
        assert!(reported(&actions, ServiceState::Running));
        assert!(!supervisor.finished());
    }

    #[test]
    fn cleanup_outcomes_map_to_honest_exit_codes() {
        for (cleanup, expected) in [
            (CleanupOutcome::Confirmed, ExitCode::Clean),
            (CleanupOutcome::Failed, ExitCode::Unknown),
            (CleanupOutcome::Unknown, ExitCode::Unknown),
            (CleanupOutcome::Refused, ExitCode::Unknown),
        ] {
            let mut supervisor = Supervisor::new(config());
            supervisor.begin(ms(0));
            supervisor.on_child_spawned(identity(42));
            supervisor.on_control(ms(100), Control::Stop);
            let actions = supervisor.on_forced_termination(cleanup);
            assert!(reported(&actions, ServiceState::Stopped));
            assert_eq!(supervisor.exit_code(), expected, "cleanup {cleanup:?}");
            assert!(supervisor.finished());
        }
    }

    #[test]
    fn a_publish_failure_finishes_with_an_unknown_cause() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));
        let actions = supervisor.on_publish_failure();
        assert!(reported(&actions, ServiceState::Stopped));
        assert_eq!(supervisor.exit_code(), ExitCode::Unknown);
        assert!(supervisor.finished());
    }

    #[test]
    fn planned_stop_drains_to_stopped() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));

        let actions = supervisor.on_control(ms(100), Control::Stop);
        assert!(reported(&actions, ServiceState::StopPending));
        assert!(actions.contains(&SupervisorAction::RequestGracefulStop));

        // The child exits on its own inside the drain window.
        let actions = supervisor.on_child_exited(ms(200), 0);
        assert!(reported(&actions, ServiceState::Stopped));
        assert!(supervisor.finished());
        assert_eq!(supervisor.exit_code(), ExitCode::Clean);
    }

    #[test]
    fn repeated_stop_is_ignored() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));
        supervisor.on_control(ms(100), Control::Stop);
        let actions = supervisor.on_control(ms(110), Control::Stop);
        assert!(actions.is_empty());
    }

    #[test]
    fn planned_stop_is_not_reported_as_a_failure() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));
        supervisor.on_control(ms(100), Control::Stop);
        supervisor.on_child_exited(ms(200), 1);
        assert_eq!(supervisor.exit_code(), ExitCode::Clean);
    }

    #[test]
    fn unexpected_exit_restarts_within_budget() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));
        let actions = supervisor.on_child_exited(ms(1_000), 7);
        assert_eq!(spawn_count(&actions), 1);
        assert!(reported(&actions, ServiceState::StartPending));
        assert!(!supervisor.finished());
    }

    #[test]
    fn repeated_failure_exhausts_the_budget() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));
        // budget is 3 restarts inside the window
        for index in 0..3 {
            supervisor.on_child_spawned(identity(42));
            let actions = supervisor.on_child_exited(ms(1_000 + index), 7);
            assert_eq!(spawn_count(&actions), 1);
            assert!(!supervisor.finished());
        }
        supervisor.on_child_spawned(identity(42));
        let actions = supervisor.on_child_exited(ms(2_000), 7);
        assert!(reported(&actions, ServiceState::Stopped));
        assert!(supervisor.finished());
        assert_eq!(supervisor.exit_code(), ExitCode::RepeatedFailure);
    }

    #[test]
    fn the_budget_window_forgets_old_restarts() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        for index in 0..3 {
            supervisor.on_child_spawned(identity(42));
            supervisor.on_child_exited(ms(1_000 + index), 7);
        }
        // Outside the 300s window the earlier restarts fall away.
        supervisor.on_child_spawned(identity(42));
        let actions = supervisor.on_child_exited(ms(500_000), 7);
        assert_eq!(spawn_count(&actions), 1);
        assert!(!supervisor.finished());
    }

    #[test]
    fn delayed_drain_forces_termination_once() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));
        supervisor.on_control(ms(100), Control::Stop);

        // Before the deadline: periodic pending reports, no termination.
        let actions = supervisor.tick(ms(200));
        assert!(reported(&actions, ServiceState::StopPending));
        assert!(!actions.contains(&SupervisorAction::ForceTerminateTree));

        let deadline = 100 + DEFAULT_DRAIN_TIMEOUT.as_millis() as u64;
        let actions = supervisor.tick(ms(deadline));
        assert!(actions.contains(&SupervisorAction::ForceTerminateTree));

        // Once issued, it is not issued again.
        let actions = supervisor.tick(ms(deadline + 1_000));
        assert!(!actions.contains(&SupervisorAction::ForceTerminateTree));

        let actions = supervisor.on_forced_termination(CleanupOutcome::Confirmed);
        assert!(reported(&actions, ServiceState::Stopped));
        assert!(supervisor.forced());
        assert_eq!(supervisor.exit_code(), ExitCode::Clean);
    }

    #[test]
    fn drain_does_not_force_terminate_while_the_child_is_gone() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        supervisor.on_child_spawned(identity(42));
        supervisor.on_control(ms(100), Control::Stop);
        supervisor.on_child_exited(ms(150), 0);
        assert!(supervisor.finished());

        // A tick after the child is gone and the service is stopped is a no-op.
        assert!(supervisor.tick(ms(100_000)).is_empty());
    }

    #[test]
    fn fatal_launch_configuration_does_not_restart() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        let actions = supervisor.on_spawn_failed(ms(10), true);
        assert_eq!(spawn_count(&actions), 0);
        assert!(supervisor.finished());
        assert_eq!(supervisor.exit_code(), ExitCode::LaunchFailure);
    }

    #[test]
    fn transient_launch_failure_restarts_then_eventually_stops() {
        let mut supervisor = Supervisor::new(config());
        supervisor.begin(ms(0));
        for index in 0..3 {
            let actions = supervisor.on_spawn_failed(ms(index), false);
            assert_eq!(spawn_count(&actions), 1);
        }
        let actions = supervisor.on_spawn_failed(ms(4), false);
        assert_eq!(spawn_count(&actions), 0);
        assert_eq!(supervisor.exit_code(), ExitCode::RepeatedFailure);
    }

    #[test]
    fn identity_verdicts_gate_cleanup() {
        assert_eq!(identity_verdict(Ok(true)), IdentityVerdict::Owned);
        assert_eq!(identity_verdict(Ok(false)), IdentityVerdict::Foreign);
        assert_eq!(identity_verdict(Err(QueryError)), IdentityVerdict::Unknown);
        assert!(may_cleanup(IdentityVerdict::Owned));
        assert!(!may_cleanup(IdentityVerdict::Foreign));
        assert!(!may_cleanup(IdentityVerdict::Unknown));
    }

    #[test]
    fn exit_codes_map_to_service_specific_errors() {
        assert_eq!(ExitCode::Clean.win32(), (0, 0));
        assert_eq!(ExitCode::Child(7).win32(), (1066, 1));
        assert_eq!(ExitCode::RepeatedFailure.win32(), (1066, 2));
        assert_eq!(ExitCode::LaunchFailure.win32(), (1066, 3));
    }
}
