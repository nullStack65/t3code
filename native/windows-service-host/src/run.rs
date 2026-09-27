//! The supervision event loop.
//!
//! This loop is shared by `--console`, the portable integration test and the
//! Windows SCM service. It executes `SupervisorAction`s, but every process
//! operation goes through the `ChildHost`, and every stop or termination first
//! verifies that the recorded process identity is still the one this host
//! spawned. A failed query leaves ownership unknown and is never read as a
//! successful stop.
//!
//! The `Reporter` is the actual SCM/runtime status boundary, so the loop treats
//! publication as fallible: a failed `report` is surfaced, not ignored, and the
//! run never claims a clean stop when its cleanup could not be confirmed.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::config::ServiceConfig;
use crate::control::{Control, ServiceState};
use crate::host::{ChildHandle, ChildHost, CleanupOutcome, SpawnError};
use crate::supervise::{ExitCode, IdentityVerdict, Supervisor, SupervisorAction, identity_verdict};

pub trait ControlInput {
    /// Wait up to `timeout` for the next control. `None` means it timed out.
    fn wait(&mut self, timeout: Duration) -> Option<Control>;
}

/// Channel-backed control input. The Windows control handler and the console
/// reader both send into this channel from their own thread.
pub struct ChannelControlInput {
    pub receiver: mpsc::Receiver<Control>,
}

impl ControlInput for ChannelControlInput {
    fn wait(&mut self, timeout: Duration) -> Option<Control> {
        self.receiver.recv_timeout(timeout).ok()
    }
}

/// Deterministic control input for tests: one entry per loop iteration, where
/// `None` yields a timeout and lets the loop poll the child.
#[derive(Debug, Default)]
pub struct ScriptedControl {
    pub script: std::collections::VecDeque<Option<Control>>,
}

impl ControlInput for ScriptedControl {
    fn wait(&mut self, _timeout: Duration) -> Option<Control> {
        self.script.pop_front().flatten()
    }
}

/// A status publication failure. `win32_error` is the `GetLastError` value the
/// SCM reporter observed; tests use a synthetic value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublishError {
    pub win32_error: u32,
}

pub trait Reporter {
    fn report(
        &mut self,
        state: ServiceState,
        exit: ExitCode,
        checkpoint: u32,
    ) -> Result<(), PublishError>;
}

pub struct RunOutcome {
    pub exit: ExitCode,
    pub forced: bool,
    /// True when the exit came from observing the child, not from a forced
    /// termination. Useful to keep "stop completed" honest in logs.
    pub exit_observed: bool,
    /// True when at least one status publication failed. The failure is
    /// surfaced here and the run does not claim a clean stop.
    pub publish_failed: bool,
}

pub fn run<H, C, R>(
    config: &ServiceConfig,
    host: &mut H,
    controls: &mut C,
    reporter: &mut R,
    log: &mut dyn FnMut(&str),
) -> RunOutcome
where
    H: ChildHost,
    C: ControlInput,
    R: Reporter,
{
    let start = Instant::now();
    let now = move || start.elapsed();
    let mut supervisor = Supervisor::new(config.clone());
    let mut child: Option<H::Child> = None;
    let mut exit_observed = false;
    let mut publish_failed = false;
    let mut aborting = false;

    let mut queue = supervisor.begin(now());
    loop {
        while !queue.is_empty() {
            let actions = std::mem::take(&mut queue);
            let (follow_up, failed) = execute(
                actions,
                config,
                &mut supervisor,
                host,
                &mut child,
                reporter,
                now(),
                log,
            );
            queue = follow_up;
            publish_failed |= failed;
        }

        // A failed publication means the SCM no longer tracks our true state
        // (a failed RUNNING report advertises no stop controls). Abandon the run
        // once, cleaning the owned child, and report an unknown cause.
        if publish_failed && !aborting && !supervisor.finished() {
            aborting = true;
            log("status publication failed; abandoning the run");
            let cleanup = terminate_child::<H>(&mut child);
            child = None;
            log(&format!("abandon cleanup outcome: {cleanup:?}"));
            queue = supervisor.on_publish_failure();
            continue;
        }

        if supervisor.finished() {
            break;
        }

        if let Some(control) = controls.wait(config.poll_interval) {
            queue = supervisor.on_control(now(), control);
            continue;
        }

        if let Some(handle) = child.as_mut() {
            match handle.try_wait() {
                Ok(Some(code)) => {
                    // The root exiting is not proof the whole owned tree is gone.
                    // Reclaim the job through its retained handle and use that
                    // evidence before finishing clean or starting a replacement.
                    let cleanup = handle.cleanup_after_exit();
                    log(&format!(
                        "child exited (code {code}); owned-tree cleanup: {cleanup:?}"
                    ));
                    child = None;
                    exit_observed = true;
                    queue = supervisor.on_child_exited(now(), code, cleanup);
                    continue;
                }
                Ok(None) => {}
                Err(_) => log("child query failed; status remains unknown, not stopped"),
            }
        }

        queue = supervisor.tick(now());
    }

    RunOutcome {
        exit: supervisor.exit_code(),
        forced: supervisor.forced(),
        exit_observed,
        publish_failed,
    }
}

/// Terminate the held child if its identity is still verified-owned.
fn terminate_child<H: ChildHost>(child: &mut Option<H::Child>) -> CleanupOutcome {
    match child.as_mut() {
        Some(handle) => match identity_verdict(handle.verify_identity()) {
            IdentityVerdict::Owned => handle.terminate_tree(),
            IdentityVerdict::Foreign => CleanupOutcome::Refused,
            IdentityVerdict::Unknown => CleanupOutcome::Unknown,
        },
        None => CleanupOutcome::Confirmed,
    }
}

#[allow(clippy::too_many_arguments)]
fn execute<H: ChildHost, R: Reporter>(
    actions: Vec<SupervisorAction>,
    config: &ServiceConfig,
    supervisor: &mut Supervisor,
    host: &mut H,
    child: &mut Option<H::Child>,
    reporter: &mut R,
    now: Duration,
    log: &mut dyn FnMut(&str),
) -> (Vec<SupervisorAction>, bool) {
    let mut follow_up = Vec::new();
    let mut publish_failed = false;
    for action in actions {
        match action {
            SupervisorAction::SpawnChild => match host.spawn(config) {
                Ok(spawned) => {
                    let identity = spawned.identity();
                    *child = Some(spawned);
                    follow_up.extend(supervisor.on_child_spawned(identity));
                }
                Err(SpawnError::Config(message)) => {
                    log(&format!("refusing to launch: {message}"));
                    follow_up.extend(supervisor.on_spawn_failed(now, true));
                }
                Err(SpawnError::Launch(message)) => {
                    log(&format!("launch failed: {message}"));
                    follow_up.extend(supervisor.on_spawn_failed(now, false));
                }
                Err(SpawnError::Admission(failure)) => {
                    log(&format!(
                        "admission failed at {:?}: {} (created-process cleanup: {:?})",
                        failure.stage, failure.reason, failure.cleanup
                    ));
                    if failure.cleanup.is_clean() {
                        // The created process was confirmed reclaimed, so this is
                        // the ordinary bounded transient-launch retry.
                        follow_up.extend(supervisor.on_spawn_failed(now, false));
                    } else {
                        // The created process may still exist outside the job.
                        // Starting another could leak a second orphan, so stop
                        // and report the unresolved ownership instead.
                        log(
                            "admission cleanup could not be confirmed; not retrying and reporting unresolved ownership",
                        );
                        follow_up.extend(supervisor.on_admission_cleanup_unconfirmed());
                    }
                }
            },
            SupervisorAction::RequestGracefulStop => match child.as_mut() {
                Some(handle) => match identity_verdict(handle.verify_identity()) {
                    IdentityVerdict::Owned => {
                        if handle.request_graceful_stop().is_err() {
                            log("stop request could not be delivered; bounded termination remains");
                        }
                    }
                    IdentityVerdict::Foreign => {
                        log("refusing to stop: recorded PID now belongs to another process")
                    }
                    IdentityVerdict::Unknown => {
                        log("process identity unknown; not assuming the child stopped")
                    }
                },
                None => {
                    follow_up.extend(supervisor.on_forced_termination(CleanupOutcome::Confirmed))
                }
            },
            SupervisorAction::ForceTerminateTree => {
                let cleanup = terminate_child::<H>(child);
                // Releasing the held job handle is itself a termination effect
                // for a kill-on-close job; the outcome above is what we report,
                // not the implicit drop.
                *child = None;
                follow_up.extend(supervisor.on_forced_termination(cleanup));
            }
            SupervisorAction::Report { state, exit } => {
                if let Err(error) = reporter.report(state, exit, supervisor.checkpoint()) {
                    log(&format!(
                        "status publication failed (win32 {}); service state is not represented",
                        error.win32_error
                    ));
                    publish_failed = true;
                }
            }
        }
    }
    (follow_up, publish_failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LaunchMode, ServiceConfig};
    use crate::host::{ChildHandle, ProcessIdentity, QueryError, SpawnError};
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    type Events = Arc<Mutex<Vec<String>>>;

    #[derive(Clone)]
    struct FakeChild {
        alive: bool,
        owned: bool,
        query_fails: bool,
        graceful_kills: bool,
        terminate_outcome: CleanupOutcome,
        after_exit_outcome: CleanupOutcome,
        events: Events,
        unrelated_alive: Arc<AtomicBool>,
    }

    impl Drop for FakeChild {
        fn drop(&mut self) {
            debug_assert!(
                self.unrelated_alive.load(Ordering::SeqCst),
                "host cleanup must never touch an unrelated process"
            );
            // Closing a kill-on-close job terminates its owned members. A held
            // child dropped while still alive is therefore still a termination
            // effect, even when no terminate method was called.
            if self.alive {
                self.events.lock().unwrap().push("job-drop".to_owned());
                self.alive = false;
            }
        }
    }

    impl ChildHandle for FakeChild {
        fn identity(&self) -> ProcessIdentity {
            ProcessIdentity {
                pid: 7,
                created_at_ms: 1,
            }
        }
        fn verify_identity(&mut self) -> Result<bool, QueryError> {
            if self.query_fails {
                Err(QueryError)
            } else {
                Ok(self.owned)
            }
        }
        fn try_wait(&mut self) -> Result<Option<i32>, QueryError> {
            if self.query_fails {
                Err(QueryError)
            } else if self.alive {
                Ok(None)
            } else {
                Ok(Some(0))
            }
        }
        fn request_graceful_stop(&mut self) -> Result<(), QueryError> {
            self.events.lock().unwrap().push("graceful".to_owned());
            if self.graceful_kills {
                self.alive = false;
            }
            Ok(())
        }
        fn terminate_tree(&mut self) -> CleanupOutcome {
            self.events.lock().unwrap().push("terminate".to_owned());
            if self.terminate_outcome.is_clean() {
                self.alive = false;
            }
            self.terminate_outcome
        }
        fn cleanup_after_exit(&mut self) -> CleanupOutcome {
            self.events
                .lock()
                .unwrap()
                .push("cleanup-after-exit".to_owned());
            if self.after_exit_outcome.is_clean() {
                self.alive = false;
            }
            self.after_exit_outcome
        }
    }

    struct FakeHost {
        template: FakeChild,
    }

    impl ChildHost for FakeHost {
        type Child = FakeChild;
        fn spawn(&mut self, _config: &ServiceConfig) -> Result<FakeChild, SpawnError> {
            self.template
                .events
                .lock()
                .unwrap()
                .push("spawn".to_owned());
            Ok(self.template.clone())
        }
    }

    /// A host whose spawn always fails admission, carrying the injected cleanup
    /// outcome. Used to prove the spawn→run retry decision structurally.
    struct AdmissionFailHost {
        cleanup: CleanupOutcome,
        events: Events,
        attempts: usize,
    }

    impl ChildHost for AdmissionFailHost {
        type Child = FakeChild;
        fn spawn(&mut self, _config: &ServiceConfig) -> Result<FakeChild, SpawnError> {
            self.attempts += 1;
            self.events.lock().unwrap().push("spawn".to_owned());
            Err(SpawnError::Admission(crate::admission::AdmissionFailure {
                stage: crate::admission::AdmissionStage::AssignToJob,
                reason: "AssignProcessToJobObject failed (5)".to_owned(),
                cleanup: self.cleanup,
            }))
        }
    }

    struct Recorder {
        events: Events,
    }

    impl Reporter for Recorder {
        fn report(
            &mut self,
            state: ServiceState,
            exit: ExitCode,
            _checkpoint: u32,
        ) -> Result<(), PublishError> {
            self.events
                .lock()
                .unwrap()
                .push(format!("report:{state:?}:{exit:?}"));
            Ok(())
        }
    }

    struct FailingReporter {
        fail_on: ServiceState,
        events: Events,
    }

    impl Reporter for FailingReporter {
        fn report(
            &mut self,
            state: ServiceState,
            exit: ExitCode,
            _checkpoint: u32,
        ) -> Result<(), PublishError> {
            self.events
                .lock()
                .unwrap()
                .push(format!("report:{state:?}:{exit:?}"));
            if state == self.fail_on {
                Err(PublishError { win32_error: 1066 })
            } else {
                Ok(())
            }
        }
    }

    fn config() -> ServiceConfig {
        ServiceConfig {
            home: PathBuf::from("."),
            runtime: PathBuf::new(),
            log: None,
            service_name: "t3code".to_owned(),
            drain_timeout: Duration::ZERO,
            restart_window: Duration::from_secs(300),
            max_restarts: 3,
            poll_interval: Duration::from_millis(1),
            expected_account: None,
            allow_local_system: false,
            mode: LaunchMode::ServiceLauncher,
        }
    }

    fn child(options: ChildOptions, events: &Events) -> FakeChild {
        FakeChild {
            alive: options.alive,
            owned: options.owned,
            query_fails: options.query_fails,
            graceful_kills: options.graceful_kills,
            terminate_outcome: options.terminate_outcome,
            after_exit_outcome: options.after_exit_outcome,
            events: events.clone(),
            unrelated_alive: options.unrelated_alive,
        }
    }

    #[derive(Clone)]
    struct ChildOptions {
        alive: bool,
        owned: bool,
        query_fails: bool,
        graceful_kills: bool,
        terminate_outcome: CleanupOutcome,
        after_exit_outcome: CleanupOutcome,
        unrelated_alive: Arc<AtomicBool>,
    }

    impl Default for ChildOptions {
        fn default() -> Self {
            Self {
                alive: true,
                owned: true,
                query_fails: false,
                graceful_kills: false,
                terminate_outcome: CleanupOutcome::Confirmed,
                after_exit_outcome: CleanupOutcome::Confirmed,
                unrelated_alive: Arc::new(AtomicBool::new(true)),
            }
        }
    }

    fn run_events(options: ChildOptions, controls: Vec<Option<Control>>) -> (Events, RunOutcome) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let mut host = FakeHost {
            template: child(options, &events),
        };
        let mut controls = ScriptedControl {
            script: VecDeque::from(controls),
        };
        let mut recorder = Recorder {
            events: events.clone(),
        };
        let mut log = |_message: &str| {};
        let outcome = run(&config(), &mut host, &mut controls, &mut recorder, &mut log);
        (events, outcome)
    }

    fn contains(events: &Events, needle: &str) -> bool {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.contains(needle))
    }

    fn trace(events: &Events) -> Vec<String> {
        events.lock().unwrap().clone()
    }

    fn spawn_count(events: &Events) -> usize {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.as_str() == "spawn")
            .count()
    }

    fn stop_and_force() -> Vec<Option<Control>> {
        vec![None, Some(Control::Stop)]
    }

    #[test]
    fn successful_spawn_publishes_running_before_stop() {
        let (events, _outcome) = run_events(ChildOptions::default(), stop_and_force());
        let trace = trace(&events);
        let running = trace
            .iter()
            .position(|event| event == "report:Running:Clean")
            .expect("a successful spawn must publish RUNNING");
        let stopping = trace
            .iter()
            .position(|event| event == "report:StopPending:Clean")
            .expect("a stop must publish STOP_PENDING");
        assert!(running < stopping, "RUNNING must precede the stop");
    }

    #[test]
    fn there_is_exactly_one_final_stopped_report() {
        let (events, _outcome) = run_events(ChildOptions::default(), stop_and_force());
        let trace = trace(&events);
        let stopped = trace
            .iter()
            .filter(|event| event.starts_with("report:Stopped"))
            .count();
        assert_eq!(
            stopped, 1,
            "SCM requires exactly one final STOPPED: {trace:?}"
        );
        let last_report = trace
            .iter()
            .filter(|event| event.starts_with("report:"))
            .next_back()
            .expect("at least one report");
        assert!(last_report.starts_with("report:Stopped"));
    }

    #[test]
    fn graceful_child_exit_publishes_running_then_one_stopped() {
        let options = ChildOptions {
            graceful_kills: true,
            ..ChildOptions::default()
        };
        let (events, outcome) = run_events(options, stop_and_force());
        assert!(contains(&events, "report:Running:Clean"));
        let trace = trace(&events);
        assert_eq!(
            trace
                .iter()
                .filter(|event| event.starts_with("report:Stopped"))
                .count(),
            1
        );
        assert_eq!(outcome.exit, ExitCode::Clean);
        assert!(!outcome.publish_failed);
    }

    #[test]
    fn owned_tree_receives_graceful_stop_then_confirmed_termination() {
        let (events, outcome) = run_events(ChildOptions::default(), stop_and_force());
        assert!(contains(&events, "graceful"));
        assert!(contains(&events, "terminate"));
        assert!(contains(&events, "report:Stopped:Clean"));
        assert!(outcome.forced);
    }

    #[test]
    fn foreign_pid_is_not_terminated_and_not_reported_clean() {
        let options = ChildOptions {
            owned: false,
            ..ChildOptions::default()
        };
        let (events, outcome) = run_events(options, stop_and_force());
        assert!(contains(&events, "report:Stopped:Unknown"));
        assert!(!outcome.publish_failed);
        assert!(
            !contains(&events, "terminate"),
            "a foreign process must not be terminated"
        );
        assert!(
            !contains(&events, "graceful"),
            "a foreign process must not receive a stop request"
        );
        // Dropping the still-held kill-on-close job is itself an effect, so the
        // test records it rather than treating "no terminate call" as clean.
        assert!(
            contains(&events, "job-drop"),
            "the held job drop must be observable, not hidden"
        );
    }

    #[test]
    fn a_refused_tree_does_not_touch_unrelated_processes() {
        let unrelated_alive = Arc::new(AtomicBool::new(true));
        let options = ChildOptions {
            owned: false,
            unrelated_alive: unrelated_alive.clone(),
            ..ChildOptions::default()
        };
        let (_events, _outcome) = run_events(options, stop_and_force());
        assert!(
            unrelated_alive.load(Ordering::SeqCst),
            "no unrelated process may be cleaned up"
        );
    }

    #[test]
    fn query_failure_is_not_treated_as_an_owned_tree() {
        let options = ChildOptions {
            query_fails: true,
            ..ChildOptions::default()
        };
        let (events, _outcome) = run_events(options, stop_and_force());
        assert!(contains(&events, "report:Stopped:Unknown"));
        assert!(
            !contains(&events, "terminate"),
            "an unverifiable tree must not be terminated"
        );
    }

    #[test]
    fn failed_termination_is_not_reported_clean() {
        let options = ChildOptions {
            terminate_outcome: CleanupOutcome::Failed,
            ..ChildOptions::default()
        };
        let (events, outcome) = run_events(options, stop_and_force());
        assert!(contains(&events, "report:Stopped:Unknown"));
        assert_ne!(outcome.exit, ExitCode::Clean);
        assert!(!outcome.exit_observed, "no clean child exit was observed");
    }

    #[test]
    fn successful_termination_request_with_a_nonempty_job_is_not_clean() {
        // `TerminateJobObject` is only a request; a job still nonempty after the
        // bounded wait is a failed cleanup, never a clean stop.
        let options = ChildOptions {
            terminate_outcome: CleanupOutcome::Failed,
            ..ChildOptions::default()
        };
        let (events, outcome) = run_events(options, stop_and_force());
        assert!(contains(&events, "terminate"));
        assert_ne!(outcome.exit, ExitCode::Clean);
        assert!(contains(&events, "report:Stopped:Unknown"));
    }

    #[test]
    fn root_exit_with_a_living_grandchild_is_not_clean() {
        // The root exited during a planned stop, but the job stayed nonempty, so
        // whole-tree cleanup could not be confirmed.
        let options = ChildOptions {
            alive: false,
            after_exit_outcome: CleanupOutcome::Failed,
            ..ChildOptions::default()
        };
        let (events, outcome) = run_events(options, vec![Some(Control::Stop), None]);
        assert!(
            contains(&events, "cleanup-after-exit"),
            "the post-exit cleanup must be explicit"
        );
        assert!(contains(&events, "report:Stopped:RecoveryRequired"));
        assert_ne!(outcome.exit, ExitCode::Clean);
        assert_eq!(spawn_count(&events), 1, "no replacement tree is started");
    }

    #[test]
    fn natural_exit_during_a_planned_stop_is_clean_only_when_the_job_is_empty() {
        let options = ChildOptions {
            alive: false,
            after_exit_outcome: CleanupOutcome::Confirmed,
            ..ChildOptions::default()
        };
        let (events, outcome) = run_events(options, vec![Some(Control::Stop), None]);
        assert!(contains(&events, "report:Stopped:Clean"));
        assert_eq!(outcome.exit, ExitCode::Clean);
    }

    #[test]
    fn unexpected_exit_with_an_unconfirmed_job_does_not_replace_the_child() {
        let options = ChildOptions {
            alive: false,
            after_exit_outcome: CleanupOutcome::Unknown,
            ..ChildOptions::default()
        };
        let (events, outcome) = run_events(options, vec![None]);
        assert_eq!(spawn_count(&events), 1, "the tree is not replaced");
        assert_eq!(outcome.exit, ExitCode::RecoveryRequired);
        assert!(contains(&events, "report:Stopped:RecoveryRequired"));
    }

    #[test]
    fn job_query_failure_on_a_natural_exit_is_not_clean() {
        let options = ChildOptions {
            alive: false,
            after_exit_outcome: CleanupOutcome::Unknown,
            ..ChildOptions::default()
        };
        let (events, outcome) = run_events(options, stop_and_force());
        assert_eq!(spawn_count(&events), 1);
        assert_ne!(outcome.exit, ExitCode::Clean);
    }

    #[test]
    fn a_natural_exit_does_not_touch_an_unrelated_process() {
        let unrelated_alive = Arc::new(AtomicBool::new(true));
        let options = ChildOptions {
            alive: false,
            after_exit_outcome: CleanupOutcome::Failed,
            unrelated_alive: unrelated_alive.clone(),
            ..ChildOptions::default()
        };
        let _ = run_events(options, vec![Some(Control::Stop), None]);
        assert!(
            unrelated_alive.load(Ordering::SeqCst),
            "job cleanup must never reach an unrelated process"
        );
    }

    #[test]
    fn unconfirmed_admission_cleanup_stops_without_a_second_spawn() {
        // Fault-inject assignment failure plus a failed or unknown/timeout
        // reclaim through the real spawn→run decision.
        for cleanup in [CleanupOutcome::Failed, CleanupOutcome::Unknown] {
            let events: Events = Arc::new(Mutex::new(Vec::new()));
            let mut host = AdmissionFailHost {
                cleanup,
                events: events.clone(),
                attempts: 0,
            };
            let mut controls = ScriptedControl {
                script: VecDeque::new(),
            };
            let mut recorder = Recorder {
                events: events.clone(),
            };
            let mut log = |_message: &str| {};
            let outcome = run(&config(), &mut host, &mut controls, &mut recorder, &mut log);
            assert_eq!(
                host.attempts, 1,
                "an unconfirmed admission cleanup ({cleanup:?}) must not retry"
            );
            assert_eq!(outcome.exit, ExitCode::RecoveryRequired, "{cleanup:?}");
            assert!(contains(&events, "report:Stopped:RecoveryRequired"));
        }
    }

    #[test]
    fn confirmed_admission_cleanup_takes_the_bounded_retry() {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let mut host = AdmissionFailHost {
            cleanup: CleanupOutcome::Confirmed,
            events: events.clone(),
            attempts: 0,
        };
        let mut controls = ScriptedControl {
            script: VecDeque::new(),
        };
        let mut recorder = Recorder {
            events: events.clone(),
        };
        let mut log = |_message: &str| {};
        let outcome = run(&config(), &mut host, &mut controls, &mut recorder, &mut log);
        // config() allows 3 restarts, so 1 initial attempt + 3 retries.
        assert_eq!(host.attempts, 4);
        assert_eq!(outcome.exit, ExitCode::RepeatedFailure);
    }

    #[test]
    fn publish_failure_is_surfaced_and_does_not_claim_clean() {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let options = ChildOptions::default();
        let mut host = FakeHost {
            template: child(options, &events),
        };
        let mut controls = ScriptedControl {
            script: VecDeque::from(stop_and_force()),
        };
        let mut reporter = FailingReporter {
            fail_on: ServiceState::Running,
            events: events.clone(),
        };
        let mut log = |_message: &str| {};
        let outcome = run(&config(), &mut host, &mut controls, &mut reporter, &mut log);

        assert!(
            outcome.publish_failed,
            "the failed RUNNING report must surface"
        );
        assert_ne!(
            outcome.exit,
            ExitCode::Clean,
            "no clean stop without publication"
        );
        let trace = trace(&events);
        assert_eq!(
            trace
                .iter()
                .filter(|event| event.starts_with("report:Stopped"))
                .count(),
            1,
            "abort must still end in exactly one STOPPED: {trace:?}"
        );
    }
}
