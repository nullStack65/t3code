//! SCM dispatch, the control handler and status reporting.
//!
//! `StartServiceCtrlDispatcherW` connects this process to the service control
//! manager. It must run on the process's main thread. `ServiceMain` runs on an
//! SCM-owned thread and must not block: it registers the extended control
//! handler, starts the supervisor, and returns when the service stops.
//!
//! The control handler only records intent and wakes the supervisor through a
//! channel; it never waits on the child. This is what keeps control handling
//! from hanging when the launcher is slow to drain.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::mpsc;

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Security::Authentication::Identity::{
    EXTENDED_NAME_FORMAT, GetUserNameExW, NameSamCompatible, NameUserPrincipal,
};
use windows_sys::Win32::System::Services::{
    RegisterServiceCtrlHandlerExW, SERVICE_STATUS, SERVICE_STATUS_HANDLE, SERVICE_TABLE_ENTRYW,
    SetServiceStatus, StartServiceCtrlDispatcherW,
};

use super::job::WindowsChildHost;
use crate::account;
use crate::config::ServiceConfig;
use crate::control::{Control, ServiceState};
use crate::run::{ChannelControlInput, PublishError, Reporter, run};
use crate::supervise::ExitCode;

const SERVICE_WIN32_OWN_PROCESS: u32 = 0x0000_0010;
const SERVICE_ACCEPT_STOP: u32 = 0x0000_0001;
const SERVICE_ACCEPT_SHUTDOWN: u32 = 0x0000_0004;
const NO_ERROR: u32 = 0;
const WAIT_HINT_MS: u32 = 30_000;

struct Shared {
    sender: mpsc::Sender<Control>,
    status_handle: AtomicIsize,
    state: AtomicU32,
    win32_exit: AtomicU32,
    specific_exit: AtomicU32,
    checkpoint: AtomicU32,
    service_name: Vec<u16>,
}

static CONFIG: OnceLock<ServiceConfig> = OnceLock::new();
static SHARED: OnceLock<Shared> = OnceLock::new();
static SETTLED: OnceLock<ExitCode> = OnceLock::new();

/// Connect to SCM and run until the service stops. Windows only.
pub fn run_service(config: ServiceConfig) -> Result<ExitCode, String> {
    if CONFIG.set(config).is_err() {
        return Err("the service host was initialized twice".to_owned());
    }
    let config = CONFIG.get().expect("configuration just set");
    if let Err(reason) = check_service_account(config) {
        return Err(reason);
    }
    let name = wide_null(&config.service_name);
    let name = Box::leak(name.into_boxed_slice());
    let dispatch_table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_mut_ptr(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: std::ptr::null_mut(),
            lpServiceProc: None,
        },
    ];
    let started = unsafe { StartServiceCtrlDispatcherW(dispatch_table.as_ptr()) };
    if started == 0 {
        return Err(format!("StartServiceCtrlDispatcherW failed ({})", unsafe {
            GetLastError()
        }));
    }
    Ok(SETTLED.get().copied().unwrap_or(ExitCode::Unknown))
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut *mut u16) {
    let config = match CONFIG.get() {
        Some(config) => config,
        None => return,
    };
    let (sender, receiver) = mpsc::channel();
    let shared = Shared {
        sender,
        status_handle: AtomicIsize::new(0),
        state: AtomicU32::new(ServiceState::StartPending.win32_state()),
        win32_exit: AtomicU32::new(0),
        specific_exit: AtomicU32::new(0),
        checkpoint: AtomicU32::new(0),
        service_name: wide_null(&config.service_name),
    };
    if SHARED.set(shared).is_err() {
        return;
    }
    let shared = SHARED.get().expect("shared state just set");
    let handle = unsafe {
        RegisterServiceCtrlHandlerExW(
            shared.service_name.as_ptr(),
            Some(control_handler),
            shared as *const Shared as *mut core::ffi::c_void,
        )
    };
    if handle as isize == 0 {
        let _ = SETTLED.set(ExitCode::Unknown);
        return;
    }
    shared
        .status_handle
        .store(handle as isize, Ordering::SeqCst);
    if let Err(error) = emit_status(shared) {
        append_log(
            config.log.as_ref(),
            &format!(
                "could not publish the initial status ({})",
                error.win32_error
            ),
        );
        let _ = SETTLED.set(ExitCode::Unknown);
        return;
    }

    let mut host = WindowsChildHost::new();
    let mut controls = ChannelControlInput { receiver };
    let mut reporter = ScmReporter;
    let log_path = config.log.clone();
    let mut log = |message: &str| append_log(log_path.as_ref(), message);
    // `run` publishes the single final STOPPED itself. Reporting STOPPED here as
    // well would be a second status update after the SCM may already have
    // released this service's context (Microsoft SetServiceStatus contract).
    let outcome = run(config, &mut host, &mut controls, &mut reporter, &mut log);
    if outcome.publish_failed {
        append_log(
            log_path.as_ref(),
            "a status publication failed; the SCM may not have observed the final state",
        );
    }
    let settled = if outcome.publish_failed {
        ExitCode::Unknown
    } else {
        outcome.exit
    };
    let _ = SETTLED.set(settled);
}

unsafe extern "system" fn control_handler(
    control: u32,
    _event_type: u32,
    _event_data: *mut core::ffi::c_void,
    context: *mut core::ffi::c_void,
) -> u32 {
    let shared = unsafe { &*(context as *const Shared) };
    match Control::from_win32(control) {
        Control::Stop | Control::Shutdown => {
            // Unbounded channel: this never blocks the SCM thread.
            let _ = shared.sender.send(Control::from_win32(control));
        }
        Control::Interrogate => {
            let _ = emit_status(shared);
        }
        Control::Other => {}
    }
    NO_ERROR
}

struct ScmReporter;

impl Reporter for ScmReporter {
    fn report(
        &mut self,
        state: ServiceState,
        exit: ExitCode,
        checkpoint: u32,
    ) -> Result<(), PublishError> {
        set_status(state, exit, checkpoint)
    }
}

fn set_status(state: ServiceState, exit: ExitCode, checkpoint: u32) -> Result<(), PublishError> {
    let Some(shared) = SHARED.get() else {
        return Err(PublishError { win32_error: 0 });
    };
    shared.state.store(state.win32_state(), Ordering::SeqCst);
    let (win32, specific) = exit.win32();
    shared.win32_exit.store(win32, Ordering::SeqCst);
    shared.specific_exit.store(specific, Ordering::SeqCst);
    shared.checkpoint.store(checkpoint, Ordering::SeqCst);
    emit_status(shared)
}

fn emit_status(shared: &Shared) -> Result<(), PublishError> {
    let raw = shared.status_handle.load(Ordering::SeqCst);
    if raw == 0 {
        return Err(PublishError { win32_error: 0 });
    }
    let state = shared.state.load(Ordering::SeqCst);
    let pending = state == ServiceState::StartPending.win32_state()
        || state == ServiceState::StopPending.win32_state();
    let mut status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == ServiceState::Running.win32_state() {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: shared.win32_exit.load(Ordering::SeqCst),
        dwServiceSpecificExitCode: shared.specific_exit.load(Ordering::SeqCst),
        dwCheckPoint: shared.checkpoint.load(Ordering::SeqCst),
        dwWaitHint: if pending { WAIT_HINT_MS } else { 0 },
    };
    let accepted = unsafe { SetServiceStatus(raw as SERVICE_STATUS_HANDLE, &mut status) };
    if accepted == 0 {
        return Err(PublishError {
            win32_error: unsafe { GetLastError() },
        });
    }
    Ok(())
}

/// Refuse the default LocalSystem workload and enforce a qualified expected
/// account. The account password is never here: SCM stores it in LSA and
/// starts the process under that token.
fn check_service_account(config: &ServiceConfig) -> Result<(), String> {
    let sam = qualified_user_name(NameSamCompatible);
    let upn = qualified_user_name(NameUserPrincipal);
    if sam.is_none() && upn.is_none() {
        return Err(
            "could not read a qualified service account identity; refusing to start".to_owned(),
        );
    }
    if !config.allow_local_system && account::is_local_system(sam.as_deref()) {
        return Err(
            "refusing to run the T3 workload as LocalSystem; register the service with a dedicated account"
                .to_owned(),
        );
    }
    if let Some(expected) = &config.expected_account {
        if !account::qualified_match(expected, sam.as_deref(), upn.as_deref()) {
            let observed = sam.or(upn).unwrap_or_else(|| "unknown".to_owned());
            return Err(format!(
                "service account '{observed}' does not match the expected account '{expected}'"
            ));
        }
    }
    Ok(())
}

/// A qualified account name from `GetUserNameExW`. The bare-name API is not
/// used: without a domain qualifier it cannot prove the account binding.
fn qualified_user_name(format: EXTENDED_NAME_FORMAT) -> Option<String> {
    let mut size: u32 = 0;
    unsafe {
        // First call sizes the buffer; the expected ERROR_MORE_DATA is not an
        // error for this probe.
        GetUserNameExW(format, std::ptr::null_mut(), &mut size);
    }
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0u16; size as usize];
    let ok = unsafe { GetUserNameExW(format, buffer.as_mut_ptr(), &mut size) };
    if !ok {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

fn append_log(log_path: Option<&PathBuf>, message: &str) {
    use std::io::Write;
    let line = format!("[t3-windows-service-host] {message}\n");
    match log_path {
        Some(path) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = file.write_all(line.as_bytes());
            }
        }
        None => eprint!("{line}"),
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
