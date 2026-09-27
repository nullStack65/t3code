//! Windows process-tree ownership through a job object.
//!
//! The child is created suspended, assigned to a job with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, its identity captured, and then it is
//! resumed. Suspending closes the race where a fast child could spawn
//! grandchildren before assignment and escape termination. Every step after a
//! successful `CreateProcessW` is checked and unwound: a failure reclaims the
//! freshly created process rather than leaving a suspended orphan. Creating the
//! job here (rather than putting this host in one) means only the descendants of
//! the launcher are owned; the host stays alive to report `SERVICE_STOPPED`.
//!
//! `verify_identity` re-opens the PID and compares its creation time with the
//! one recorded at spawn. A handle we already hold stays valid after the child
//! exits, so it cannot detect PID reuse; a fresh query can. A failed query is
//! returned as an error (`unknown`), never as ownership.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
    SetFilePointer,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOW,
    TerminateProcess, WaitForSingleObject,
};

use crate::admission::{AdmissionFailure, AdmissionOps, AdmissionStage, admit};
use crate::config::{LaunchMode, ServiceConfig};
use crate::host::{
    ChildHandle, ChildHost, CleanupOutcome, ProcessIdentity, QueryError, SpawnError,
};

const GENERIC_WRITE: u32 = 0x4000_0000;
/// Bounded wait for an explicitly terminated process to be observed as gone.
const TERMINATE_WAIT_MS: u32 = 5_000;

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

pub struct WindowsChildHost;

impl Default for WindowsChildHost {
    fn default() -> Self {
        Self
    }
}

impl WindowsChildHost {
    pub fn new() -> Self {
        Self
    }
}

pub struct WindowsChild {
    process: Handle,
    job: Handle,
    id: ProcessIdentity,
    stop_marker: std::path::PathBuf,
    /// True once an explicit termination was confirmed. While false, dropping
    /// this holder still closes a kill-on-close job, which is itself a
    /// termination effect; `Drop` makes that effect explicit and bounded.
    terminated: bool,
}

impl WindowsChild {
    fn creation_time(process: HANDLE) -> Option<u64> {
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        let ok =
            unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
        (ok != 0).then(|| ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
    }
}

impl Drop for WindowsChild {
    fn drop(&mut self) {
        if !self.terminated {
            // Releasing a kill-on-close job terminates its members. Make that
            // implicit termination explicit and bounded here rather than
            // pretending no termination happened. Only this job's owned members
            // are affected; no PID or process name is matched.
            unsafe {
                TerminateJobObject(self.job.0, 1);
                let _ = WaitForSingleObject(self.process.0, TERMINATE_WAIT_MS);
            }
        }
    }
}

impl ChildHandle for WindowsChild {
    fn identity(&self) -> ProcessIdentity {
        self.id
    }

    fn verify_identity(&mut self) -> Result<bool, QueryError> {
        let fresh = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, self.id.pid) };
        if fresh.is_null() {
            // Query failed. Ownership is unknown, not owned and not stopped.
            return Err(QueryError);
        }
        let fresh_handle = Handle(fresh);
        match WindowsChild::creation_time(fresh_handle.0) {
            Some(created) => Ok(created == self.id.created_at_ms),
            None => Err(QueryError),
        }
    }

    fn try_wait(&mut self) -> Result<Option<i32>, QueryError> {
        let waited = unsafe { WaitForSingleObject(self.process.0, 0) };
        if waited == WAIT_TIMEOUT {
            return Ok(None);
        }
        if waited != WAIT_OBJECT_0 {
            return Err(QueryError);
        }
        let mut code: u32 = 0;
        let ok = unsafe { GetExitCodeProcess(self.process.0, &mut code) };
        if ok == 0 {
            return Err(QueryError);
        }
        Ok(Some(code as i32))
    }

    fn request_graceful_stop(&mut self) -> Result<(), QueryError> {
        if let Some(parent) = self.stop_marker.parent() {
            std::fs::create_dir_all(parent).map_err(|_| QueryError)?;
        }
        std::fs::write(&self.stop_marker, b"").map_err(|_| QueryError)
    }

    fn terminate_tree(&mut self) -> CleanupOutcome {
        let terminated = unsafe { TerminateJobObject(self.job.0, 1) };
        if terminated == 0 {
            return CleanupOutcome::Failed;
        }
        match unsafe { WaitForSingleObject(self.process.0, TERMINATE_WAIT_MS) } {
            WAIT_OBJECT_0 => {
                self.terminated = true;
                CleanupOutcome::Confirmed
            }
            _ => CleanupOutcome::Failed,
        }
    }
}

/// A process created suspended but not yet admitted. It owns the created
/// process and thread handles until cleanup has been confirmed; the job is
/// already created, so assignment is the first admission step.
struct PendingProcess {
    process: Handle,
    thread: Handle,
    job: Handle,
    pid: u32,
}

impl AdmissionOps for PendingProcess {
    fn assign_to_job(&mut self) -> Result<(), String> {
        let ok = unsafe { AssignProcessToJobObject(self.job.0, self.process.0) };
        if ok == 0 {
            Err(format!("AssignProcessToJobObject failed ({})", unsafe {
                GetLastError()
            }))
        } else {
            Ok(())
        }
    }

    fn capture_identity(&mut self) -> Result<ProcessIdentity, String> {
        match WindowsChild::creation_time(self.process.0) {
            Some(created_at_ms) => Ok(ProcessIdentity {
                pid: self.pid,
                created_at_ms,
            }),
            None => Err(format!(
                "GetProcessTimes failed ({}); identity is unknown, not zero",
                unsafe { GetLastError() }
            )),
        }
    }

    fn resume(&mut self) -> Result<(), String> {
        let previous = unsafe { ResumeThread(self.thread.0) };
        if previous == u32::MAX {
            Err(format!("ResumeThread failed ({})", unsafe {
                GetLastError()
            }))
        } else {
            Ok(())
        }
    }

    fn terminate_created(&mut self) -> CleanupOutcome {
        let terminated = unsafe { TerminateProcess(self.process.0, 1) };
        if terminated == 0 {
            return CleanupOutcome::Failed;
        }
        match unsafe { WaitForSingleObject(self.process.0, TERMINATE_WAIT_MS) } {
            WAIT_OBJECT_0 => CleanupOutcome::Confirmed,
            _ => CleanupOutcome::Failed,
        }
    }
}

fn describe_admission_failure(failure: &AdmissionFailure) -> String {
    let stage = match failure.stage {
        AdmissionStage::AssignToJob => "AssignProcessToJobObject",
        AdmissionStage::CaptureIdentity => "GetProcessTimes",
        AdmissionStage::Resume => "ResumeThread",
    };
    format!(
        "{stage}: {} (created-process cleanup: {:?})",
        failure.reason, failure.cleanup
    )
}

impl ChildHost for WindowsChildHost {
    type Child = WindowsChild;

    fn spawn(&mut self, config: &ServiceConfig) -> Result<WindowsChild, SpawnError> {
        if matches!(config.mode, LaunchMode::ServiceLauncher) && !config.home.is_dir() {
            return Err(SpawnError::Config(format!(
                "T3 home {} does not exist",
                config.home.display()
            )));
        }

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(SpawnError::Launch(format!(
                "CreateJobObjectW failed ({})",
                unsafe { GetLastError() }
            )));
        }
        let job = Handle(job);
        let limit = extended_limit();
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limit as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(SpawnError::Launch(format!(
                "SetInformationJobObject failed ({})",
                unsafe { GetLastError() }
            )));
        }

        let mut command_line = build_command_line(config);
        // Bind the native child to the selected home. Passing NULL here would
        // inherit an ambient T3CODE_HOME (absent or pointing elsewhere); cwd is
        // not what the pinned launcher reads.
        let environment = crate::environment::host_environment(&config.home);
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;

        let mut log_handle: Option<Handle> = None;
        let inherit = if let Some(log_path) = &config.log {
            if let Some(parent) = log_path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    SpawnError::Config(format!("cannot create log dir: {error}"))
                })?;
            }
            let wide = wide_null(log_path);
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null(),
                    OPEN_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(SpawnError::Config(format!(
                    "cannot open log file {} ({})",
                    log_path.display(),
                    unsafe { GetLastError() }
                )));
            }
            unsafe {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                SetFilePointer(handle, 0, std::ptr::null_mut(), 2);
            }
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = std::ptr::null_mut();
            startup.hStdOutput = handle;
            startup.hStdError = handle;
            log_handle = Some(Handle(handle));
            true
        } else {
            false
        };

        let home_wide = wide_null(&config.home);
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let created = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                inherit as i32,
                CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr() as *const core::ffi::c_void,
                home_wide.as_ptr(),
                &startup,
                &mut info,
            )
        };
        if created == 0 {
            return Err(SpawnError::Launch(format!(
                "CreateProcessW failed ({})",
                unsafe { GetLastError() }
            )));
        }
        // The child has inherited its own copy of the log handle; close ours.
        drop(log_handle);

        let mut pending = PendingProcess {
            process: Handle(info.hProcess),
            thread: Handle(info.hThread),
            job,
            pid: info.dwProcessId,
        };
        let id = match admit(&mut pending) {
            Ok(id) => id,
            Err(failure) => return Err(SpawnError::Launch(describe_admission_failure(&failure))),
        };

        let process = pending.process;
        let job = pending.job;
        drop(pending.thread);
        Ok(WindowsChild {
            process,
            job,
            id,
            stop_marker: config.stop_marker(),
            terminated: false,
        })
    }
}

fn extended_limit() -> JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    let mut limit: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limit
}

fn wide_null(value: &Path) -> Vec<u16> {
    value
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn build_command_line(config: &ServiceConfig) -> Vec<u16> {
    let (program, args) = config.child_command();
    let mut line = Vec::new();
    push_quoted(
        &mut line,
        &program.as_os_str().encode_wide().collect::<Vec<_>>(),
    );
    for arg in &args {
        line.push(b' ' as u16);
        push_quoted(&mut line, &arg.encode_wide().collect::<Vec<_>>());
    }
    line.push(0);
    line
}

/// Windows command-line quoting: backslashes are doubled before a quote, and a
/// literal quote needs `2n + 1` backslashes in front of it.
fn push_quoted(out: &mut Vec<u16>, value: &[u16]) {
    out.push(b'"' as u16);
    let mut backslashes = 0usize;
    for &character in value {
        if character == b'\\' as u16 {
            backslashes += 1;
            out.push(character);
        } else if character == b'"' as u16 {
            for _ in 0..backslashes + 1 {
                out.push(b'\\' as u16);
            }
            out.push(character);
            backslashes = 0;
        } else {
            backslashes = 0;
            out.push(character);
        }
    }
    for _ in 0..backslashes {
        out.push(b'\\' as u16);
    }
    out.push(b'"' as u16);
}
