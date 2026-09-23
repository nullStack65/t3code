#!/usr/bin/env node
/**
 * Verifies the WSL runtime that is actually embedded in a Windows installer.
 *
 * The packaging step already fail-closes on a missing/mismatched archive and
 * SHA sidecar, but that only proves *an* archive was embedded. A candidate must
 * also prove the embedded payload is the standalone Linux archive the release
 * publishes and that its provenance names the same source, version, and
 * architecture. This module holds the pure comparison; the CLI extracts the
 * payload with 7-Zip and calls it.
 */
import { sha256Hex, type VerificationResult } from "./fork-release-manifest.ts";

export interface EmbeddedBuildInfo {
  readonly repository: string;
  readonly sourceSha: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
}

export interface VerifyEmbeddedWslRuntimeInput {
  readonly embeddedArchive: Uint8Array | undefined;
  readonly standaloneArchive: Uint8Array | undefined;
  readonly embeddedInfo: EmbeddedBuildInfo | undefined;
  readonly standaloneInfo: EmbeddedBuildInfo | undefined;
  readonly expected: {
    readonly repository: string;
    readonly sourceSha: string;
    readonly version: string;
    readonly arch: string;
  };
}

const problems = (list: ReadonlyArray<string>): VerificationResult =>
  list.length === 0 ? { ok: true, failures: [] } : { ok: false, failures: list };

/**
 * Byte-identity plus provenance equality between the Windows installer's
 * embedded `wsl-runtime.tar.gz` and the standalone Linux x64 archive.
 */
export function verifyEmbeddedWslRuntime(input: VerifyEmbeddedWslRuntimeInput): VerificationResult {
  const failures: string[] = [];
  const { expected } = input;

  if (input.embeddedArchive === undefined) {
    failures.push("the Windows installer has no embedded WSL runtime archive");
  }
  if (input.standaloneArchive === undefined) {
    failures.push("the standalone Linux x64 archive is missing");
  }
  if (input.embeddedArchive !== undefined && input.standaloneArchive !== undefined) {
    const embedded = sha256Hex(input.embeddedArchive);
    const standalone = sha256Hex(input.standaloneArchive);
    if (embedded !== standalone) {
      failures.push(
        `embedded WSL runtime sha256 ${embedded} does not equal the standalone Linux archive ${standalone}`,
      );
    }
  }

  const info = input.embeddedInfo;
  if (info === undefined) {
    failures.push("the embedded WSL runtime has no t3code-build-info.json");
  } else {
    if (info.repository !== expected.repository) {
      failures.push(
        `embedded WSL runtime repository is ${info.repository}, expected ${expected.repository}`,
      );
    }
    if (info.sourceSha !== expected.sourceSha) {
      failures.push(
        `embedded WSL runtime sourceSha is ${info.sourceSha}, expected ${expected.sourceSha}`,
      );
    }
    if (info.version !== expected.version) {
      failures.push(
        `embedded WSL runtime version is ${info.version}, expected ${expected.version}`,
      );
    }
    if (info.platform !== "linux") {
      failures.push(`embedded WSL runtime platform is ${info.platform}, expected linux`);
    }
    if (info.arch !== expected.arch) {
      failures.push(`embedded WSL runtime arch is ${info.arch}, expected ${expected.arch}`);
    }
  }

  if (input.embeddedInfo !== undefined && input.standaloneInfo !== undefined) {
    if (JSON.stringify(input.embeddedInfo) !== JSON.stringify(input.standaloneInfo)) {
      failures.push(
        "embedded WSL runtime provenance differs from the standalone archive provenance",
      );
    }
  }

  return problems(failures);
}
