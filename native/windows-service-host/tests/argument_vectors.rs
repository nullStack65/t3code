//! Shared argument-vector test for the published host invocation contract.
//!
//! Reads the same `argument-vectors.tsv` the TypeScript adapter test consumes,
//! so the native parser and the adapter's ownership parser are checked against
//! one set of vectors. It asserts the native effective result only; it does not
//! dispatch through the SCM or touch a service.

use std::ffi::OsString;

use t3_windows_service_host::config::{ConfigError, Invocation, ServiceConfig, parse};

const VECTORS: &str = include_str!("argument-vectors.tsv");

fn config_of(invocation: Invocation) -> ServiceConfig {
    match invocation {
        Invocation::Service(config) | Invocation::Console(config) => config,
        other => panic!("expected a service config, got {other:?}"),
    }
}

#[test]
fn shared_argument_vectors_resolve_to_the_documented_effective_target() {
    let mut cases = 0;
    for line in VECTORS
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
    {
        let fields: Vec<&str> = line.split("###").map(str::trim).collect();
        assert_eq!(fields.len(), 6, "malformed vector line: {line}");
        let id = fields[0];
        let native_mode = fields[1];
        let expected_home = fields[2];
        let expected_runtime = fields[3];
        let tokens: Vec<OsString> = fields[5].split('|').map(OsString::from).collect();
        let result = parse(tokens);

        match native_mode {
            "service" => {
                let config = config_of(result.unwrap_or_else(|error| panic!("{id}: {error:?}")));
                assert_eq!(config.home.to_string_lossy(), expected_home, "{id}");
                assert_eq!(config.runtime.to_string_lossy(), expected_runtime, "{id}");
            }
            "console" => {
                let invocation = result.unwrap_or_else(|error| panic!("{id}: {error:?}"));
                assert!(
                    matches!(invocation, Invocation::Console(_)),
                    "{id}: expected console"
                );
                let config = config_of(invocation);
                assert_eq!(config.home.to_string_lossy(), expected_home, "{id}");
                assert_eq!(config.runtime.to_string_lossy(), expected_runtime, "{id}");
            }
            "error:UnknownFlag" => {
                assert!(
                    matches!(result, Err(ConfigError::UnknownFlag(_))),
                    "{id}: expected UnknownFlag"
                );
            }
            "error:MissingRuntime" => {
                assert!(
                    matches!(result, Err(ConfigError::MissingRuntime)),
                    "{id}: expected MissingRuntime"
                );
            }
            other => panic!("{id}: unknown native mode {other}"),
        }
        cases += 1;
    }
    assert_eq!(cases, 9, "expected every shared vector to be exercised");
}
