//! Portable mapping from SCM control events to supervisor intent.
//!
//! The Windows control handler runs on an SCM-owned thread and must return
//! promptly. It therefore never performs the stop itself; it records the
//! intent and wakes the supervisor thread. These functions are the pure part
//! of that mapping so they can be tested without Windows.

/// States reported through `SetServiceStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    StartPending,
    Running,
    StopPending,
    Stopped,
}

impl ServiceState {
    /// SCM `dwCurrentState` value.
    pub fn win32_state(self) -> u32 {
        match self {
            ServiceState::StartPending => 2,
            ServiceState::Running => 4,
            ServiceState::StopPending => 3,
            ServiceState::Stopped => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Stop,
    Shutdown,
    Interrogate,
    Other,
}

impl Control {
    /// Map a raw `SERVICE_CONTROL_*` value. Unknown values stay `Other` rather
    /// than being treated as a stop.
    pub fn from_win32(code: u32) -> Control {
        match code {
            1 => Control::Stop,
            5 => Control::Shutdown,
            4 => Control::Interrogate,
            _ => Control::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlOutcome {
    /// Begin a planned stop.
    StopRequested,
    /// A stop is already in flight; do not start a second one.
    AlreadyStopping,
    /// Report the current status without changing it.
    Interrogated,
    /// Ignore a control this service does not act on.
    Ignored,
}

/// Exactly the session-controls this service acts on. Interrogate has no accept
/// bit; SCM always allows it.
pub fn accepts_control(control: Control) -> bool {
    matches!(control, Control::Stop | Control::Shutdown)
}

pub fn handle_control(state: ServiceState, control: Control) -> ControlOutcome {
    match control {
        Control::Stop | Control::Shutdown => match state {
            ServiceState::Stopped | ServiceState::StopPending => ControlOutcome::AlreadyStopping,
            ServiceState::StartPending | ServiceState::Running => ControlOutcome::StopRequested,
        },
        Control::Interrogate => ControlOutcome::Interrogated,
        Control::Other => ControlOutcome::Ignored,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_raw_control_codes() {
        assert_eq!(Control::from_win32(1), Control::Stop);
        assert_eq!(Control::from_win32(5), Control::Shutdown);
        assert_eq!(Control::from_win32(4), Control::Interrogate);
        assert_eq!(Control::from_win32(255), Control::Other);
    }

    #[test]
    fn advertising_stop_and_shutdown_but_not_unknown_controls() {
        assert!(accepts_control(Control::Stop));
        assert!(accepts_control(Control::Shutdown));
        assert!(!accepts_control(Control::Other));
        assert!(!accepts_control(Control::Interrogate));
    }

    #[test]
    fn a_running_service_requests_a_stop_once() {
        assert_eq!(
            handle_control(ServiceState::Running, Control::Stop),
            ControlOutcome::StopRequested
        );
        assert_eq!(
            handle_control(ServiceState::StopPending, Control::Stop),
            ControlOutcome::AlreadyStopping
        );
        assert_eq!(
            handle_control(ServiceState::Stopped, Control::Shutdown),
            ControlOutcome::AlreadyStopping
        );
    }

    #[test]
    fn shutdown_is_treated_like_stop() {
        assert_eq!(
            handle_control(ServiceState::Running, Control::Shutdown),
            ControlOutcome::StopRequested
        );
    }

    #[test]
    fn interrogate_never_stops_the_service() {
        assert_eq!(
            handle_control(ServiceState::Running, Control::Interrogate),
            ControlOutcome::Interrogated
        );
        assert_eq!(
            handle_control(ServiceState::StopPending, Control::Interrogate),
            ControlOutcome::Interrogated
        );
    }

    #[test]
    fn unknown_controls_are_ignored() {
        assert_eq!(
            handle_control(ServiceState::Running, Control::Other),
            ControlOutcome::Ignored
        );
    }
}
