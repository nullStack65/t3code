//! Qualified service-account identity matching.
//!
//! `GetUserNameW` returns a bare account name with no domain, so comparing a
//! potentially qualified `--expected-account` against it is ambiguous: the same
//! name can exist in several domains. When the binding is supplied the host
//! therefore proves identity against qualified forms (`DOMAIN\user` from
//! `NameSamCompatible`, `user@domain` from `NameUserPrincipal`). A bare expected
//! name is rejected at configuration time because it cannot prove which domain
//! the process runs as.

/// A qualified account carries a domain component.
pub fn is_qualified(account: &str) -> bool {
    account.contains('\\') || account.contains('@')
}

/// True when the expected account matches either qualified identity form.
/// At least one identity form must be present; otherwise there is no proof.
pub fn qualified_match(expected: &str, sam: Option<&str>, upn: Option<&str>) -> bool {
    [sam, upn]
        .into_iter()
        .flatten()
        .any(|identity| identity.eq_ignore_ascii_case(expected))
}

/// True when a SAM account is LocalSystem. Used to refuse the default
/// LocalSystem workload; `--allow-local-system` is the explicit override.
pub fn is_local_system(sam: Option<&str>) -> bool {
    sam.and_then(|sam| sam.rsplit('\\').next())
        .is_some_and(|name| name.eq_ignore_ascii_case("SYSTEM"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_names_are_not_qualified() {
        assert!(!is_qualified("t3service"));
        assert!(is_qualified(r"CORP\t3service"));
        assert!(is_qualified("t3service@corp.example"));
    }

    #[test]
    fn matches_sam_and_upn_case_insensitively() {
        assert!(qualified_match(
            r"CORP\t3service",
            Some(r"corp\T3Service"),
            None
        ));
        assert!(qualified_match(
            "t3service@corp.example",
            None,
            Some("T3Service@Corp.Example")
        ));
        assert!(!qualified_match(
            r"CORP\t3service",
            Some(r"OTHER\t3service"),
            None
        ));
    }

    #[test]
    fn detects_local_system_from_the_sam_form() {
        assert!(is_local_system(Some(r"NT AUTHORITY\SYSTEM")));
        assert!(!is_local_system(Some(r"NT AUTHORITY\LocalService")));
        assert!(!is_local_system(None));
    }
}
