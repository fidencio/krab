use crate::probe::{self, Paths};

pub fn check(paths: &Paths) -> probe::Result {
    probe::character_device(&paths.dev.join("kvm"))
}
