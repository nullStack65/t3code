//! The supervision event loop.
//!
//! This loop is shared by `--console`, the portable integration test and the
//! Windows SCM service. It executes `SupervisorAction`s, but every process
//! operation goes through the `ChildHost`, and every stop or termination first
//! verifies that the recorded process identity is still the one this host
//! spawned. A failed query leaves ownership unknown and is never read as a
//! successful stop.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::config::ServiceConfig;
use crate::control::{Control, ServiceState};
use crate::host::{ChildHandle, ChildHost, SpawnError};
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

pub trait Reporter {
    fn report(&mut self, state: ServiceState, exit: ExitCode, checkpoint: u32);
}

pub struct RunOutcome {
    pub exit: ExitCode,
    pub forced: bool,
    /// True when the exit came from observing the child, not from a forced
    /// termination. Useful to keep "stop completed" honest in logs.
    pub exit_observed: bool,
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

    let mut queue = supervisor.begin(now());
    loop {
        while !queue.is_empty() {
            let actions = std::mem::take(&mut queue);
            queue = execute(
                actions,
                config,
                &mut supervisor,
                host,
                &mut child,
                reporter,
                now(),
                log,
            );
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
                    child = None;
                    exit_observed = true;
                    queue = supervisor.on_child_exited(now(), code);
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
) -> Vec<SupervisorAction> {
    let mut follow_up = Vec::new();
    for action in actions {
        match action {
            SupervisorAction::SpawnChild => match host.spawn(config) {
                Ok(spawned) => {
                    let identity = spawned.identity();
                    *child = Some(spawned);
                    supervisor.on_child_spawned(identity);
                }
                Err(SpawnError::Config(message)) => {
                    log(&format!("refusing to launch: {message}"));
                    follow_up.extend(supervisor.on_spawn_failed(now, true));
                }
                Err(SpawnError::Launch(message)) => {
                    log(&format!("launch failed: {message}"));
                    follow_up.extend(supervisor.on_spawn_failed(now, false));
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
                None => follow_up.extend(supervisor.on_forced_termination()),
            },
            SupervisorAction::ForceTerminateTree => {
                if let Some(handle) = child.as_mut() {
                    match identity_verdict(handle.verify_identity()) {
                        IdentityVerdict::Owned => handle.terminate_tree(),
                        _ => log("refusing to terminate an unverified process tree"),
                    }
                }
                *child = None;
                follow_up.extend(supervisor.on_forced_termination());
            }
            SupervisorAction::Report { state, exit } => {
                reporter.report(state, exit, supervisor.checkpoint());
            }
        }
    }
    follow_up
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LaunchMode, ServiceConfig};
    use crate::host::{ChildHandle, ProcessIdentity, QueryError, SpawnError};
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    type Events = Arc<Mutex<Vec<String>>>;

    #[derive(Clone)]
    struct FakeChild {
        alive: bool,
        owned: bool,
        query_fails: bool,
        events: Events,
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
            Ok(())
        }
        fn terminate_tree(&mut self) {
            self.events.lock().unwrap().push("terminate".to_owned());
            self.alive = false;
        }
    }

    struct FakeHost {
        child: FakeChild,
    }

    impl ChildHost for FakeHost {
        type Child = FakeChild;
        fn spawn(&mut self, _config: &ServiceConfig) -> Result<FakeChild, SpawnError> {
            Ok(self.child.clone())
        }
    }

    struct Recorder {
        events: Events,
    }

    impl Reporter for Recorder {
        fn report(&mut self, state: ServiceState, exit: ExitCode, _checkpoint: u32) {
            self.events
                .lock()
                .unwrap()
                .push(format!("report:{state:?}:{exit:?}"));
        }
    }

    fn config() -> ServiceConfig {
        ServiceConfig {
            home: PathBuf::from("."),
            runtime: PathBuf::new(),
            log: None,
            service_name: "t3code".to_owned(),
            drain_timeout: Duration::from_millis(20),
            restart_window: Duration::from_secs(300),
            max_restarts: 3,
            poll_interval: Duration::from_millis(1),
            expected_account: None,
            allow_local_system: false,
            mode: LaunchMode::ServiceLauncher,
        }
    }

    fn contains(events: &Events, needle: &str) -> bool {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.contains(needle))
    }

    fn run_with(child: FakeChild) -> (Events, RunOutcome) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let child = FakeChild {
            events: events.clone(),
            ..child
        };
        let mut host = FakeHost { child };
        let mut controls = ScriptedControl {
            script: VecDeque::from([Some(Control::Stop)]),
        };
        let mut recorder = Recorder {
            events: events.clone(),
        };
        let mut log = |_message: &str| {};
        let outcome = run(&config(), &mut host, &mut controls, &mut recorder, &mut log);
        (events, outcome)
    }

    #[test]
    fn foreign_pid_is_reported_stopped_but_never_terminated() {
        let (events, _outcome) = run_with(FakeChild {
            alive: true,
            owned: false,
            query_fails: false,
            events: Arc::new(Mutex::new(Vec::new())),
        });
        assert!(contains(&events, "report:Stopped"), "service must not hang");
        assert!(
            !contains(&events, "terminate"),
            "a foreign process must not be terminated"
        );
        assert!(
            !contains(&events, "graceful"),
            "a foreign process must not receive a stop request"
        );
    }

    #[test]
    fn query_failure_is_not_treated_as_an_owned_tree() {
        let (events, _outcome) = run_with(FakeChild {
            alive: true,
            owned: true,
            query_fails: true,
            events: Arc::new(Mutex::new(Vec::new())),
        });
        assert!(contains(&events, "report:Stopped"), "service must not hang");
        assert!(
            !contains(&events, "terminate"),
            "an unverifiable tree must not be terminated"
        );
    }

    #[test]
    fn owned_tree_receives_graceful_stop_then_bounded_termination() {
        let (events, outcome) = run_with(FakeChild {
            alive: true,
            owned: true,
            query_fails: false,
            events: Arc::new(Mutex::new(Vec::new())),
        });
        assert!(contains(&events, "graceful"));
        assert!(contains(&events, "terminate"));
        assert!(contains(&events, "report:Stopped"));
        assert!(outcome.forced);
    }
}
