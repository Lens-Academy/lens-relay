use std::{env, process::Command};

fn main() {
    let version = env_version()
        .or_else(|| git_output(&["describe", "--tags", "--exact-match"]))
        .or_else(env_sha)
        .or_else(|| git_output(&["rev-parse", "--short=12", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=GIT_VERSION={}", version);
    println!("cargo:rerun-if-env-changed=RELAY_VERSION");
    println!("cargo:rerun-if-env-changed=GITHUB_REF_TYPE");
    println!("cargo:rerun-if-env-changed=GITHUB_REF_NAME");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-env-changed=SOURCE_VERSION");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs");
}

fn env_version() -> Option<String> {
    env_value("RELAY_VERSION").or_else(|| {
        if env::var("GITHUB_REF_TYPE").as_deref() == Ok("tag") {
            env_value("GITHUB_REF_NAME")
        } else {
            None
        }
    })
}

fn env_sha() -> Option<String> {
    env_value("GITHUB_SHA")
        .or_else(|| env_value("SOURCE_VERSION"))
        .map(|value| {
            if value.len() > 12 && value.chars().all(|c| c.is_ascii_hexdigit()) {
                value[..12].to_string()
            } else {
                value
            }
        })
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn git_output(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}
