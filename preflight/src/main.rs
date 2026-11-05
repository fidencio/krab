fn main() -> std::process::ExitCode {
    krab_preflight::run_standalone(std::env::args().skip(1).collect())
}
