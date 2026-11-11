use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=TM4_SERVER_BUNDLE");
    if env::var_os("CARGO_FEATURE_EMBEDDED_SERVER").is_none() {
        return;
    }
    let root = PathBuf::from(
        env::var_os("TM4_SERVER_BUNDLE")
            .expect("Build the server bundle first and set TM4_SERVER_BUNDLE"),
    )
    .canonicalize()
    .expect("Server bundle directory missing");
    for file in [
        "site/index.html",
        "site/play/index.html",
        "site/play/tm4_web.wasm",
        "site/play/network/tm4_network_bg.wasm",
        "site/play/simulation-build.json",
        "tm4_standalone.wasm",
    ] {
        assert!(root.join(file).is_file(), "Server bundle missing {file}");
    }
    println!("cargo:rerun-if-changed={}", root.join("site").display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("tm4_standalone.wasm").display()
    );
    println!("cargo:rustc-env=TM4_SERVER_BUNDLE={}", root.display());
}
