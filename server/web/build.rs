//! The commit the game was built from, for the replays it records: one
//! played on other code plays another way (`sprawl::replay`).
fn main() {
    let commit = std::process::Command::new("git").args(["rev-parse", "--short=12", "HEAD"]).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let dirty = std::process::Command::new("git").args(["status", "--porcelain", "--untracked-files=no", "--", ".."]).output().ok().is_some_and(|o| !o.stdout.is_empty());
    println!("cargo:rustc-env=SPRAWL_COMMIT={commit}{}", if dirty { "+" } else { "" });
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/index");
}
