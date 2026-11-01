//! Service configuration and Windows-correct command-line parsing.
//!
//! The SCM starts the service process from the registered `ImagePath` command
//! line. Those arguments reach the process's ordinary entry point; they are
//! **not** delivered to `ServiceMain` for an auto-start service. The host
//! therefore parses `std::env::args_os()` in `main` before it calls
//! `StartServiceCtrlDispatcherW`, and never reads `ServiceMain`'s argv.
//!
//! Two rules matter for safety:
//!
//! - The T3 home is mandatory and must be canonical. There is no
//!   `~/.t3` fallback, so the host can never silently run a workload against
//!   an interactive user's profile because an argument was omitted.
//! - No credential may travel on the command line. SCM stores the service
//!   account password in the LSA secret store; the host refuses obvious
//!   password/token/secret flags instead of accepting them.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Bounded wait for the launcher to release its child after a stop request.
pub const DEFAULT_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
/// Restart budget window. Mirrors the systemd unit's `StartLimitIntervalSec`.
pub const DEFAULT_RESTART_WINDOW: Duration = Duration::from_secs(300);
/// Mirrors the systemd unit's `StartLimitBurst`.
pub const DEFAULT_MAX_RESTARTS: u32 = 5;
/// How often the supervisor re-reads the child while running.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(200);

const FORBIDDEN_HOME_COMPONENTS: &[&str] = &[
    "windows",
    "system32",
    "program files",
    "program files (x86)",
    "programdata",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchMode {
    /// Production: run the pinned runtime's `__service-launcher` subcommand.
    ServiceLauncher,
    /// Feature-gated development mode: run an arbitrary dummy child.
    #[cfg(feature = "test-child")]
    TestChild {
        program: PathBuf,
        args: Vec<OsString>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceConfig {
    /// Canonical T3 home. Also exported to the child as `T3CODE_HOME`.
    pub home: PathBuf,
    /// The pinned `t3.exe` the service launcher runs. Empty in test-child mode.
    pub runtime: PathBuf,
    /// Optional service log. When set, the child's stdout/stderr are redirected.
    pub log: Option<PathBuf>,
    /// SCM service name used for `RegisterServiceCtrlHandlerExW`.
    pub service_name: String,
    /// Bounded wait after a graceful stop request before force-terminating.
    pub drain_timeout: Duration,
    /// Restart budget window.
    pub restart_window: Duration,
    /// Maximum child starts inside `restart_window` before the host gives up.
    pub max_restarts: u32,
    /// How often the running child is polled.
    pub poll_interval: Duration,
    /// Expected service account. When set, the Windows layer refuses to run as
    /// any other account.
    pub expected_account: Option<String>,
    /// LocalSystem is refused unless this is explicitly set.
    pub allow_local_system: bool,
    pub mode: LaunchMode,
}

impl ServiceConfig {
    /// The exact child command this host is allowed to launch.
    pub fn child_command(&self) -> (PathBuf, Vec<OsString>) {
        match &self.mode {
            LaunchMode::ServiceLauncher => (
                self.runtime.clone(),
                vec![OsString::from("__service-launcher")],
            ),
            #[cfg(feature = "test-child")]
            LaunchMode::TestChild { program, args } => (program.clone(), args.clone()),
        }
    }

    /// Path the SCM host writes before asking the launcher to stop its child.
    /// Matches `SERVICE_STOP_MARKER_FILE` in the server's `serviceProtocol.ts`.
    pub fn stop_marker(&self) -> PathBuf {
        self.home.join("runtime").join(".service-stopping")
    }

    /// Path of the private control request the launcher watches. Matches
    /// `SERVICE_CONTROL_REQUEST_FILE` in the server's `serviceProtocol.ts`.
    pub fn control_request(&self) -> PathBuf {
        self.home
            .join("runtime")
            .join(crate::launcher_control::CONTROL_REQUEST_FILE)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    /// Dispatch through the Windows SCM. Windows only.
    Service(ServiceConfig),
    /// Run the supervisor directly against a terminal. Never proof of SCM.
    Console(ServiceConfig),
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    MissingHome,
    HomeNotAbsolute,
    HomeNotCanonical,
    MissingRuntime,
    RuntimeNotAbsolute,
    RuntimeNotPinned,
    EmptyServiceName,
    UnknownFlag(String),
    MissingValue(String),
    InvalidNumber(String),
    CredentialArgument(String),
    MissingTestChild,
    ExpectedAccountUnqualified(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::MissingHome => write!(
                formatter,
                "an explicit --home <canonical T3 home> is required; the host has no default home"
            ),
            ConfigError::HomeNotAbsolute => {
                write!(formatter, "--home must be an absolute path")
            }
            ConfigError::HomeNotCanonical => write!(
                formatter,
                "--home must name a T3 data directory, not a drive root or system directory"
            ),
            ConfigError::MissingRuntime => write!(
                formatter,
                "an explicit --runtime <path to the pinned t3.exe> is required"
            ),
            ConfigError::RuntimeNotAbsolute => {
                write!(formatter, "--runtime must be an absolute path")
            }
            ConfigError::RuntimeNotPinned => write!(
                formatter,
                "--runtime must name the pinned t3.exe executable, not another program"
            ),
            ConfigError::EmptyServiceName => write!(formatter, "--service-name must not be empty"),
            ConfigError::UnknownFlag(flag) => write!(formatter, "unknown argument '{flag}'"),
            ConfigError::MissingValue(flag) => write!(formatter, "{flag} requires a value"),
            ConfigError::InvalidNumber(flag) => write!(formatter, "{flag} requires an integer"),
            ConfigError::CredentialArgument(flag) => write!(
                formatter,
                "refusing credential argument '{flag}': the service account is registered with SCM, not passed on the command line"
            ),
            ConfigError::MissingTestChild => write!(
                formatter,
                "test-child mode requires --exec <program> [--exec-arg <value>]"
            ),
            ConfigError::ExpectedAccountUnqualified(account) => write!(
                formatter,
                "--expected-account '{account}' is not qualified; use DOMAIN\\user or user@domain so the account can be proven unambiguously"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

fn next_value(
    args: &mut std::vec::IntoIter<OsString>,
    flag: &str,
) -> Result<OsString, ConfigError> {
    args.next()
        .ok_or_else(|| ConfigError::MissingValue(flag.to_owned()))
}

fn parse_duration_ms(flag: &str, value: &OsString) -> Result<Duration, ConfigError> {
    value
        .to_str()
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(Duration::from_millis)
        .ok_or_else(|| ConfigError::InvalidNumber(flag.to_owned()))
}

fn parse_u32(flag: &str, value: &OsString) -> Result<u32, ConfigError> {
    value
        .to_str()
        .and_then(|raw| raw.parse::<u32>().ok())
        .ok_or_else(|| ConfigError::InvalidNumber(flag.to_owned()))
}

/// Absolute on either POSIX or Windows rules. The host is cross-checked from a
/// developer host, so Windows drive and UNC prefixes are recognized without
/// relying on the running platform's `Path` semantics.
pub fn is_absolute_path(path: &Path) -> bool {
    if path.is_absolute() {
        return true;
    }
    let raw = path.to_string_lossy();
    let bytes = raw.as_bytes();
    let drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    drive_absolute || raw.starts_with("\\\\")
}

/// Split a path into lower-cased name segments on either separator, dropping
/// the drive prefix and empty segments.
fn name_segments(path: &Path) -> Vec<String> {
    path.to_string_lossy()
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty() && *segment != "." && !segment.ends_with(':'))
        .map(str::to_ascii_lowercase)
        .collect()
}

/// Reject drive roots and well-known system directories. This is a guardrail,
/// not a security boundary: an administrator registering the service still
/// chooses the home, and the account constraint is what actually protects
/// other users' data.
pub fn is_canonical_t3_home(path: &Path) -> bool {
    if !is_absolute_path(path) {
        return false;
    }
    let raw = path.to_string_lossy();
    if raw.split(['\\', '/']).any(|segment| segment == "..") {
        return false;
    }
    let normal = name_segments(path);
    if normal.is_empty() {
        return false;
    }
    !normal
        .iter()
        .any(|part| FORBIDDEN_HOME_COMPONENTS.contains(&part.as_str()))
}

fn is_pinned_runtime(path: &Path) -> bool {
    path.to_string_lossy()
        .split(['\\', '/'])
        .next_back()
        .is_some_and(|name| name.eq_ignore_ascii_case("t3.exe"))
}

/// Parse the process command line. `args` is the full `args_os()` iterator,
/// including argv[0].
pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Invocation, ConfigError> {
    let mut args = args.into_iter().collect::<Vec<_>>().into_iter();
    let _program = args.next();

    let mut home: Option<PathBuf> = None;
    let mut runtime: Option<PathBuf> = None;
    let mut log: Option<PathBuf> = None;
    let mut service_name = String::from("t3code");
    let mut service_name_set = false;
    let mut drain_timeout = DEFAULT_DRAIN_TIMEOUT;
    let mut restart_window = DEFAULT_RESTART_WINDOW;
    let mut max_restarts = DEFAULT_MAX_RESTARTS;
    let mut expected_account: Option<String> = None;
    let mut allow_local_system = false;
    let mut console = false;
    let mut help = false;
    let mut version = false;
    #[cfg(feature = "test-child")]
    let mut test_program: Option<PathBuf> = None;
    #[cfg(feature = "test-child")]
    let mut test_args: Vec<OsString> = Vec::new();

    while let Some(raw) = args.next() {
        let flag = raw.to_string_lossy().into_owned();
        let (name, inline) = match flag.split_once('=') {
            Some((name, value)) => (name.to_owned(), Some(OsString::from(value))),
            None => (flag.clone(), None),
        };
        let mut take = |flag: &str| -> Result<OsString, ConfigError> {
            match inline.clone() {
                Some(value) => Ok(value),
                None => next_value(&mut args, flag),
            }
        };

        match name.as_str() {
            "--home" => home = Some(PathBuf::from(take("--home")?)),
            "--runtime" => runtime = Some(PathBuf::from(take("--runtime")?)),
            "--log" => log = Some(PathBuf::from(take("--log")?)),
            "--service-name" => {
                let value = take("--service-name")?;
                service_name = value.to_string_lossy().into_owned();
                service_name_set = true;
            }
            "--drain-timeout-ms" => {
                drain_timeout =
                    parse_duration_ms("--drain-timeout-ms", &take("--drain-timeout-ms")?)?
            }
            "--restart-window-ms" => {
                restart_window =
                    parse_duration_ms("--restart-window-ms", &take("--restart-window-ms")?)?
            }
            "--max-restarts" => {
                max_restarts = parse_u32("--max-restarts", &take("--max-restarts")?)?
            }
            "--expected-account" => {
                expected_account = Some(take("--expected-account")?.to_string_lossy().into_owned())
            }
            "--allow-local-system" => allow_local_system = true,
            "--console" => console = true,
            "--help" | "-h" => help = true,
            "--version" | "-V" => version = true,
            #[cfg(feature = "test-child")]
            "--exec" => test_program = Some(PathBuf::from(take("--exec")?)),
            #[cfg(feature = "test-child")]
            "--exec-arg" => test_args.push(take("--exec-arg")?),
            other => {
                let lowered = other.to_ascii_lowercase();
                if lowered.contains("password")
                    || lowered.contains("token")
                    || lowered.contains("secret")
                {
                    return Err(ConfigError::CredentialArgument(other.to_owned()));
                }
                return Err(ConfigError::UnknownFlag(other.to_owned()));
            }
        }
    }

    if help {
        return Ok(Invocation::Help);
    }
    if version {
        return Ok(Invocation::Version);
    }

    let home = home.ok_or(ConfigError::MissingHome)?;
    if !is_absolute_path(&home) {
        return Err(ConfigError::HomeNotAbsolute);
    }
    if !is_canonical_t3_home(&home) {
        return Err(ConfigError::HomeNotCanonical);
    }
    if service_name_set && service_name.is_empty() {
        return Err(ConfigError::EmptyServiceName);
    }
    if let Some(expected) = &expected_account {
        if !crate::account::is_qualified(expected) {
            return Err(ConfigError::ExpectedAccountUnqualified(expected.clone()));
        }
    }

    #[cfg(feature = "test-child")]
    let mode = if let Some(program) = test_program {
        LaunchMode::TestChild {
            program,
            args: test_args,
        }
    } else {
        LaunchMode::ServiceLauncher
    };
    #[cfg(not(feature = "test-child"))]
    let mode = LaunchMode::ServiceLauncher;

    let runtime_path = runtime.unwrap_or_default();
    match &mode {
        LaunchMode::ServiceLauncher => {
            if runtime_path.as_os_str().is_empty() {
                return Err(ConfigError::MissingRuntime);
            }
            if !is_absolute_path(&runtime_path) {
                return Err(ConfigError::RuntimeNotAbsolute);
            }
            if !is_pinned_runtime(&runtime_path) {
                return Err(ConfigError::RuntimeNotPinned);
            }
        }
        #[cfg(feature = "test-child")]
        LaunchMode::TestChild { .. } => {}
    }

    let config = ServiceConfig {
        home,
        runtime: runtime_path,
        log,
        service_name,
        drain_timeout,
        restart_window,
        max_restarts,
        poll_interval: DEFAULT_POLL_INTERVAL,
        expected_account,
        allow_local_system,
        mode,
    };

    Ok(if console {
        Invocation::Console(config)
    } else {
        Invocation::Service(config)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(args: &[&str]) -> Result<Invocation, ConfigError> {
        parse(args.iter().map(OsString::from))
    }

    fn windows_home() -> &'static str {
        r"C:\Users\t3service\.t3"
    }

    fn windows_runtime() -> &'static str {
        r"C:\Users\t3service\.t3\runtime\versions\0.0.42\t3.exe"
    }

    #[test]
    fn requires_explicit_home_and_runtime() {
        assert_eq!(
            parse_str(&["t3-windows-service-host"]).unwrap_err(),
            ConfigError::MissingHome
        );
        assert_eq!(
            parse_str(&["t3-windows-service-host", "--home", windows_home()]).unwrap_err(),
            ConfigError::MissingRuntime
        );
    }

    #[test]
    fn accepts_a_canonical_home_and_pinned_runtime() {
        let invocation = parse_str(&[
            "t3-windows-service-host",
            "--home",
            windows_home(),
            "--runtime",
            windows_runtime(),
        ])
        .expect("valid configuration");
        match invocation {
            Invocation::Service(config) => {
                assert_eq!(config.home, PathBuf::from(windows_home()));
                assert_eq!(config.service_name, "t3code");
                assert_eq!(config.mode, LaunchMode::ServiceLauncher);
            }
            other => panic!("expected service invocation, got {other:?}"),
        }
    }

    #[test]
    fn supports_equals_and_os_native_paths_with_spaces() {
        let invocation = parse_str(&[
            "t3-windows-service-host",
            r"--home=C:\Users\T3 Service\.t3",
            r"--runtime=C:\Users\T3 Service\.t3\runtime\versions\0.0.42\t3.exe",
            "--service-name=T3 Code",
        ])
        .expect("valid configuration");
        match invocation {
            Invocation::Service(config) => {
                assert!(config.home.to_string_lossy().contains("T3 Service"));
                assert_eq!(config.service_name, "T3 Code");
            }
            other => panic!("expected service invocation, got {other:?}"),
        }
    }

    #[test]
    fn rejects_relative_home() {
        assert_eq!(
            parse_str(&["host", "--home", r"relative\.t3"]).unwrap_err(),
            ConfigError::HomeNotAbsolute
        );
    }

    #[test]
    fn rejects_drive_root_and_system_directories() {
        assert_eq!(
            parse_str(&["host", "--home", r"C:\"]).unwrap_err(),
            ConfigError::HomeNotCanonical
        );
        assert_eq!(
            parse_str(&["host", "--home", r"C:\Windows"]).unwrap_err(),
            ConfigError::HomeNotCanonical
        );
    }

    #[test]
    fn rejects_an_unpinned_runtime() {
        let error = parse_str(&[
            "host",
            "--home",
            windows_home(),
            "--runtime",
            r"C:\Users\t3service\.t3\runtime\versions\0.0.42\other.exe",
        ])
        .unwrap_err();
        assert_eq!(error, ConfigError::RuntimeNotPinned);
    }

    #[test]
    fn refuses_credential_arguments() {
        let error = parse_str(&[
            "host",
            "--home",
            windows_home(),
            "--runtime",
            windows_runtime(),
            "--password",
            "hunter2",
        ])
        .unwrap_err();
        assert!(matches!(error, ConfigError::CredentialArgument(_)));
    }

    #[test]
    fn refuses_an_unqualified_expected_account() {
        let error = parse_str(&[
            "host",
            "--home",
            windows_home(),
            "--runtime",
            windows_runtime(),
            "--expected-account",
            "t3service",
        ])
        .unwrap_err();
        assert!(matches!(error, ConfigError::ExpectedAccountUnqualified(_)));
    }

    #[test]
    fn accepts_a_qualified_expected_account() {
        let invocation = parse_str(&[
            "host",
            "--home",
            windows_home(),
            "--runtime",
            windows_runtime(),
            "--expected-account",
            r"NT SERVICE\T3Code",
        ])
        .expect("qualified account is accepted");
        assert!(matches!(invocation, Invocation::Service(_)));
    }

    #[test]
    fn refuses_unknown_flags() {
        let error = parse_str(&["host", "--frobnicate"]).unwrap_err();
        assert_eq!(error, ConfigError::UnknownFlag("--frobnicate".to_owned()));
    }

    #[test]
    fn console_mode_keeps_the_same_configuration() {
        let invocation = parse_str(&[
            "host",
            "--console",
            "--home",
            windows_home(),
            "--runtime",
            windows_runtime(),
        ])
        .expect("valid configuration");
        assert!(matches!(invocation, Invocation::Console(_)));
    }

    #[test]
    fn stop_marker_matches_the_launcher_protocol() {
        let config = ServiceConfig {
            home: PathBuf::from(windows_home()),
            runtime: PathBuf::from(windows_runtime()),
            log: None,
            service_name: "t3code".to_owned(),
            drain_timeout: DEFAULT_DRAIN_TIMEOUT,
            restart_window: DEFAULT_RESTART_WINDOW,
            max_restarts: DEFAULT_MAX_RESTARTS,
            poll_interval: DEFAULT_POLL_INTERVAL,
            expected_account: None,
            allow_local_system: false,
            mode: LaunchMode::ServiceLauncher,
        };
        assert!(config.stop_marker().ends_with("runtime/.service-stopping"));
    }
}
