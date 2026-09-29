//! `relay version --commit` is parsed by scripts/prod/build-relay-image.sh and
//! crates/Dockerfile.prebuilt to refuse a stale prebuilt binary. Keep its output
//! exactly the build commit (or exact tag) and nothing else.

use std::process::Command;

#[test]
fn version_commit_prints_only_the_build_commit() {
    let out = Command::new(env!("CARGO_BIN_EXE_relay"))
        .args(["version", "--commit"])
        .output()
        .expect("run relay version --commit");
    assert!(out.status.success(), "exit status {:?}", out.status);
    let stdout = String::from_utf8(out.stdout).expect("utf-8 stdout");
    assert_eq!(stdout, format!("{}\n", env!("GIT_VERSION")));
    assert!(!env!("GIT_VERSION").contains(char::is_whitespace));
}
