//! Scoped, checked process admission.
//!
//! `CreateProcessW` returns a *suspended* process. Three steps must all succeed
//! before the host may own it: assign it to the job object, capture its
//! creation-time identity, and resume its primary thread. A failure at any step
//! must reclaim the freshly created process explicitly — a suspended child left
//! outside the job is an orphan, and closing its handle does not terminate it.
//!
//! The native implementation retains the created process handle until the
//! cleanup outcome is known and reports that outcome with the failure. This
//! module is portable so each failure can be injected without Windows.

use crate::host::{CleanupOutcome, ProcessIdentity};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionStage {
    AssignToJob,
    CaptureIdentity,
    Resume,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionFailure {
    pub stage: AdmissionStage,
    pub reason: String,
    /// What happened when the freshly created process was reclaimed. A failure
    /// to confirm cleanup is itself part of the admission failure.
    pub cleanup: CleanupOutcome,
}

/// The native operations an admission needs. Implemented over the real handles
/// in `windows::job`; tests inject each failure through a portable fake.
pub trait AdmissionOps {
    fn assign_to_job(&mut self) -> Result<(), String>;
    fn capture_identity(&mut self) -> Result<ProcessIdentity, String>;
    fn resume(&mut self) -> Result<(), String>;
    /// Terminate the freshly created process and report whether that is confirmed.
    fn terminate_created(&mut self) -> CleanupOutcome;
}

pub fn admit<O: AdmissionOps>(ops: &mut O) -> Result<ProcessIdentity, AdmissionFailure> {
    if let Err(reason) = ops.assign_to_job() {
        return Err(AdmissionFailure {
            stage: AdmissionStage::AssignToJob,
            reason,
            cleanup: ops.terminate_created(),
        });
    }
    let identity = match ops.capture_identity() {
        Ok(identity) => identity,
        Err(reason) => {
            return Err(AdmissionFailure {
                stage: AdmissionStage::CaptureIdentity,
                reason,
                cleanup: ops.terminate_created(),
            });
        }
    };
    if let Err(reason) = ops.resume() {
        return Err(AdmissionFailure {
            stage: AdmissionStage::Resume,
            reason,
            cleanup: ops.terminate_created(),
        });
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeOps {
        fail_assign: bool,
        fail_identity: bool,
        fail_resume: bool,
        cleanup: Option<CleanupOutcome>,
        terminated: bool,
    }

    impl AdmissionOps for FakeOps {
        fn assign_to_job(&mut self) -> Result<(), String> {
            if self.fail_assign {
                Err("assign failed".to_owned())
            } else {
                Ok(())
            }
        }
        fn capture_identity(&mut self) -> Result<ProcessIdentity, String> {
            if self.fail_identity {
                Err("creation time unavailable".to_owned())
            } else {
                Ok(ProcessIdentity {
                    pid: 42,
                    created_at_ms: 1_000,
                })
            }
        }
        fn resume(&mut self) -> Result<(), String> {
            if self.fail_resume {
                Err("resume failed".to_owned())
            } else {
                Ok(())
            }
        }
        fn terminate_created(&mut self) -> CleanupOutcome {
            self.terminated = true;
            self.cleanup.unwrap_or(CleanupOutcome::Confirmed)
        }
    }

    #[test]
    fn success_does_not_terminate_the_created_process() {
        let mut ops = FakeOps::default();
        let identity = admit(&mut ops).expect("admission succeeds");
        assert_eq!(identity.pid, 42);
        assert!(
            !ops.terminated,
            "a successfully admitted process is not cleaned up"
        );
    }

    #[test]
    fn assignment_failure_reclaims_the_created_process() {
        let mut ops = FakeOps {
            fail_assign: true,
            ..FakeOps::default()
        };
        let failure = admit(&mut ops).unwrap_err();
        assert_eq!(failure.stage, AdmissionStage::AssignToJob);
        assert!(
            ops.terminated,
            "the suspended child must not be left orphaned"
        );
        assert_eq!(failure.cleanup, CleanupOutcome::Confirmed);
    }

    #[test]
    fn identity_failure_reclaims_the_created_process() {
        let mut ops = FakeOps {
            fail_identity: true,
            ..FakeOps::default()
        };
        let failure = admit(&mut ops).unwrap_err();
        assert_eq!(failure.stage, AdmissionStage::CaptureIdentity);
        assert!(ops.terminated);
    }

    #[test]
    fn resume_failure_reclaims_the_created_process() {
        let mut ops = FakeOps {
            fail_resume: true,
            ..FakeOps::default()
        };
        let failure = admit(&mut ops).unwrap_err();
        assert_eq!(failure.stage, AdmissionStage::Resume);
        assert!(ops.terminated);
    }

    #[test]
    fn an_unconfirmed_cleanup_is_reported_with_the_failure() {
        let mut ops = FakeOps {
            fail_assign: true,
            cleanup: Some(CleanupOutcome::Failed),
            ..FakeOps::default()
        };
        let failure = admit(&mut ops).unwrap_err();
        assert_eq!(failure.cleanup, CleanupOutcome::Failed);
    }

    #[test]
    fn a_timed_out_or_unknown_cleanup_is_reported_with_the_failure() {
        for cleanup in [CleanupOutcome::Failed, CleanupOutcome::Unknown] {
            let mut ops = FakeOps {
                fail_resume: true,
                cleanup: Some(cleanup),
                ..FakeOps::default()
            };
            let failure = admit(&mut ops).unwrap_err();
            assert_eq!(failure.stage, AdmissionStage::Resume);
            assert!(
                ops.terminated,
                "the created process is always reclaimed explicitly first"
            );
            assert_eq!(failure.cleanup, cleanup);
        }
    }
}
