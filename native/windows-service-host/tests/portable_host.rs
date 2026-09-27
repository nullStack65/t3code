//! Portable integration test for the real `CommandChildHost`.
//!
//! This runs on a Unix developer host: it spawns a real dummy child through the
//! production `ServiceLauncher` code path, requests a graceful stop, lets the
//! drain deadline pass, and asserts the child is terminated. It does not prove
//! SCM dispatch or Windows job-object ownership; those are the unexecuted
//! native gate in the scoped design.
#![cfg(unix)]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use t3_windows_service_host::config::{LaunchMode, ServiceConfig};
use t3_windows_service_host::control::{Control, ServiceState};
use t3_windows_service_host::host::CommandChildHost;
use t3_windows_service_host::run::{PublishError, Reporter, ScriptedControl, run};
use t3_windows_service_host::supervise::ExitCode;

#[derive(Clone)]
struct Capturing {
    events: Arc<Mutex<Vec<String>>>,
}

impl Reporter for Capturing {
    fn report(
        &mut self,
        state: ServiceState,
        exit: ExitCode,
        _checkpoint: u32,
    ) -> Result<(), PublishError> {
        self.events
            .lock()
            .unwrap()
            .push(format!("{state:?}:{exit:?}"));
        Ok(())
    }
}

fn unique_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("t3-winsvc-{}-{nanos}", std::process::id()))
}

fn write_runtime(home: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let runtime = home.join("t3.exe");
    let pid_file = home.join("child.pid");
    let script = format!(
        "#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n",
        pid_file.display()
    );
    std::fs::write(&runtime, script).unwrap();
    std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o755)).unwrap();
    runtime
}

#[test]
fn real_child_is_stopped_and_terminated_after_drain() {
    let dir = unique_dir();
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let runtime = write_runtime(&home);

    let config = ServiceConfig {
        home: home.clone(),
        runtime,
        log: Some(home.join("service.log")),
        service_name: "t3code-test".to_owned(),
        drain_timeout: Duration::from_millis(150),
        restart_window: Duration::from_secs(300),
        max_restarts: 3,
        poll_interval: Duration::from_millis(2),
        expected_account: None,
        allow_local_system: false,
        mode: LaunchMode::ServiceLauncher,
    };

    let events = Arc::new(Mutex::new(Vec::new()));
    let mut host = CommandChildHost::new(&config);
    let mut controls = ScriptedControl {
        script: VecDeque::from([None, None, Some(Control::Stop), None, None, None, None]),
    };
    let mut reporter = Capturing {
        events: events.clone(),
    };
    let mut log = |_message: &str| {};

    let outcome = run(&config, &mut host, &mut controls, &mut reporter, &mut log);

    let reports = events.lock().unwrap().clone();
    assert!(
        reports
            .iter()
            .any(|event| event.starts_with("Stopped:Clean"))
    );
    assert!(outcome.forced, "slow drain must be force-terminated");
    assert!(
        config.stop_marker().exists(),
        "the launcher stop marker must be written before termination"
    );
    assert!(
        config.log.as_ref().is_some_and(|log| log.exists()),
        "child output must be redirected to the configured log"
    );

    let pid: i32 = std::fs::read_to_string(home.join("child.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let alive = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("kill -0 {pid} 2>/dev/null"))
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    assert!(
        !alive,
        "the child process must be gone after the service stops"
    );

    std::fs::remove_dir_all(&dir).ok();
}
