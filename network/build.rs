use std::{env, fs, path::PathBuf};

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
    for file in ["tm4_standalone.wasm", "simulation-build.json"] {
        assert!(root.join(file).is_file(), "Server bundle missing {file}");
        println!("cargo:rerun-if-changed={}", root.join(file).display());
    }
    let modules = root.join("modules");
    println!("cargo:rerun-if-changed={}", modules.display());
    let mut paths: Vec<_> = fs::read_dir(&modules)
        .expect("Module directory missing")
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "wasm"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "Server bundle has no resource modules");
    let entries = paths
        .iter()
        .map(|path| {
            format!(
                "({:?}, include_bytes!({:?}) as &[u8]),",
                path.file_name().unwrap().to_str().unwrap(),
                path.to_str().unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("modules.rs"),
        format!("&[\n{entries}\n]\n"),
    )
    .unwrap();
    println!("cargo:rustc-env=TM4_SERVER_BUNDLE={}", root.display());
}
