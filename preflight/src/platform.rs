pub fn architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "powerpc64" if cfg!(target_endian = "little") => "ppc64le",
        other => other,
    }
}

pub fn supports_gpu(architecture: &str) -> bool {
    matches!(architecture, "amd64" | "arm64")
}

#[cfg(test)]
mod tests {
    use super::supports_gpu;

    #[test]
    fn gpu_checks_are_limited_to_amd64_and_arm64() {
        assert!(supports_gpu("amd64"));
        assert!(supports_gpu("arm64"));
        assert!(!supports_gpu("s390x"));
    }
}
