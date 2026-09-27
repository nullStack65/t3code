//! Entry point.
//!
//! The command line is parsed here, before any SCM call, because the service
//! arguments arrive through the process command line and not through
//! `ServiceMain`. `--console` runs the same supervisor against a terminal for
//! development; it is never proof that SCM integration works.

use std::io::BufRead;
use std::process::ExitCode as StdExitCode;
use std::sync::mpsc;
use std::thread;

use t3_windows_service_host::config::{Invocation, ServiceConfig, parse};
use t3_windows_service_host::control::{Control, ServiceState};
use t3_windows_service_host::host::CommandChildHost;
use t3_windows_service_host::run::{ChannelControlInput, PublishError, Reporter, run};
use t3_windows_service_host::supervise::ExitCode;

fn main() -> StdExitCode {
    match parse(std::env::args_os()) {
        Ok(Invocation::Help) => {
            print_help();
            StdExitCode::SUCCESS
        }
        Ok(Invocation::Version) => {
            println!("t3-windows-service-host {}", env!("CARGO_PKG_VERSION"));
            StdExitCode::SUCCESS
        }
        Ok(Invocation::Console(config)) => exit_code(run_console(&config)),
        Ok(Invocation::Service(config)) => exit_code(run_service(config)),
        Err(error) => {
            eprintln!("t3-windows-service-host: {error}");
            StdExitCode::from(2)
        }
    }
}

fn exit_code(result: ExitCode) -> StdExitCode {
    match result {
        ExitCode::Clean => StdExitCode::SUCCESS,
        _ => StdExitCode::from(1),
    }
}

#[cfg(windows)]
fn run_service(config: ServiceConfig) -> ExitCode {
    match t3_windows_service_host::windows::run_service(config) {
        Ok(exit) => exit,
        Err(reason) => {
            eprintln!("t3-windows-service-host: {reason}");
            ExitCode::LaunchFailure
        }
    }
}

#[cfg(not(windows))]
fn run_service(_config: ServiceConfig) -> ExitCode {
    eprintln!(
        "t3-windows-service-host: SCM dispatch is only available on Windows; pass --console for the portable supervisor"
    );
    ExitCode::LaunchFailure
}

struct ConsoleReporter;

impl Reporter for ConsoleReporter {
    fn report(
        &mut self,
        state: ServiceState,
        exit: ExitCode,
        checkpoint: u32,
    ) -> Result<(), PublishError> {
        println!("[t3-service] state={state:?} exit={exit:?} checkpoint={checkpoint}");
        Ok(())
    }
}

fn run_console(config: &ServiceConfig) -> ExitCode {
    let (sender, receiver) = mpsc::channel::<Control>();
    let reader = thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let command = match line {
                Ok(line) => line.trim().to_ascii_lowercase(),
                Err(_) => break,
            };
            let control = match command.as_str() {
                "stop" | "shutdown" | "quit" | "exit" => Control::Stop,
                "interrogate" | "status" => Control::Interrogate,
                "" => continue,
                _ => {
                    eprintln!("[console] unknown command '{command}'; use stop or status");
                    continue;
                }
            };
            if sender.send(control).is_err() {
                return;
            }
        }
        // EOF (for example a closed pipe) is treated as a stop request.
        let _ = sender.send(Control::Stop);
    });

    let mut host = CommandChildHost::new(config);
    let mut controls = ChannelControlInput { receiver };
    let mut reporter = ConsoleReporter;
    let mut log = |message: &str| eprintln!("[t3-service] {message}");
    let outcome = run(config, &mut host, &mut controls, &mut reporter, &mut log);
    drop(controls);
    let _ = reader.join();
    println!(
        "[t3-service] exited exit={:?} forced={} observed={}",
        outcome.exit, outcome.forced, outcome.exit_observed
    );
    outcome.exit
}

fn print_help() {
    println!(
        "\
t3-windows-service-host {version}

A minimal T3-owned Windows SCM host. It runs the pinned `t3.exe
__service-launcher` under a job object and reports service state to the service
control manager. Not a general-purpose service wrapper.

USAGE:
  t3-windows-service-host --home <dir> --runtime <t3.exe> [options]
  t3-windows-service-host --console --home <dir> --runtime <t3.exe> [options]

REQUIRED:
  --home <dir>            Canonical T3 home. Exported to the child as
                          T3CODE_HOME. There is no default.
  --runtime <t3.exe>      Pinned runtime executable. The host appends
                          `__service-launcher`; it never manages updates.

OPTIONS:
  --log <file>            Redirect child stdout/stderr. Defaults to inherit.
  --service-name <name>   SCM registration name (default: t3code).
  --expected-account <n>  Refuse to run as any other account.
  --allow-local-system    Allow LocalSystem (discouraged; off by default).
  --drain-timeout-ms <n>  Bounded wait after a stop request (default: 30000).
  --restart-window-ms <n> Restart budget window (default: 300000).
  --max-restarts <n>      Restarts allowed inside the window (default: 5).
  --console               Run against a terminal, not SCM (development only).
  --help, --version

The service account is registered with SCM out of band (`sc.exe create ... obj=
...`); its password, if any, stays in LSA and is never passed here.",
        version = env!("CARGO_PKG_VERSION")
    );
}
