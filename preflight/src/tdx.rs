use crate::probe::{self, Paths};

pub fn check(paths: &Paths) -> probe::Result {
    probe::boolean_file(&paths.sys.join("module/kvm_intel/parameters/tdx"))
}
