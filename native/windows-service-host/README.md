# t3-windows-service-host

Minimal T3-owned Windows SCM host. It runs the pinned `t3.exe
__service-launcher` under a job object and reports service state to the
service control manager. It is not a general-purpose service wrapper and does
not manage T3 updates; the launcher owns those.

See [docs/internals/windows-background-service.md](../../docs/internals/windows-background-service.md)
for the SCM contract, account constraints, the required launcher control
adaptation, and the native acceptance checklist.

## Build and test

```sh
# Portable core (developer host, no Windows toolchain needed):
cargo test --locked --manifest-path native/windows-service-host/Cargo.toml

# Type-check the Windows-only SCM and job-object module:
cargo check --locked --target x86_64-pc-windows-msvc \
  --manifest-path native/windows-service-host/Cargo.toml

# Windows release binary (Windows host):
cargo build --locked --release --manifest-path native/windows-service-host/Cargo.toml
```

The SCM dispatch path is unqualified until the native recipe in the design doc
runs on a disposable Windows environment. `--console` exercises the same
supervisor against a terminal and is not SCM proof.
