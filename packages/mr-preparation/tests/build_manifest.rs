use rm4_mr_preparation::{BuildManifest, ModuleTarget, module_file, module_symbol};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn wasm(name: &str, value: i32) -> Vec<u8> {
    wat::parse_str(format!(
        "(module (@custom \"rm4.module\" \"{name}\") (global i32 (i32.const {value})))"
    ))
    .unwrap()
}
fn manifest(browser: &[u8], authority: &[u8]) -> Value {
    json!({
        "sha256": "a".repeat(64), "authoritySha256": digest(b"authority core"),
        "modules": [{"name": "c_toy.wasm", "sha256": digest(browser), "authoritySha256": digest(authority)}]
    })
}
fn parse(value: &Value) -> anyhow::Result<BuildManifest> {
    BuildManifest::parse(&serde_json::to_vec(value)?)
}

#[test]
fn targets_verify_their_own_bytes_and_registry_identity() -> anyhow::Result<()> {
    let browser = wasm("c_toy.sym", 1);
    let authority = wasm("c_toy.sym", 2);
    let value = manifest(&browser, &authority);
    let build = parse(&value)?;
    assert_eq!(build.sha256(), "a".repeat(64));
    assert_eq!(build.authority_sha256(), digest(b"authority core"));
    assert_eq!(build.module_names().collect::<Vec<_>>(), ["c_toy.wasm"]);
    assert_eq!(
        build.verify_module("c_toy.wasm", &browser, ModuleTarget::Browser)?,
        "c_toy.sym"
    );
    assert_eq!(
        build.verify_module("c_toy.wasm", &authority, ModuleTarget::Authority)?,
        "c_toy.sym"
    );
    assert!(
        build
            .verify_module("c_toy.wasm", &browser, ModuleTarget::Authority)
            .is_err()
    );
    assert!(
        build
            .verify_module("c_toy.wasm", &authority, ModuleTarget::Browser)
            .is_err()
    );
    assert!(
        build
            .verify_module("unknown.wasm", &browser, ModuleTarget::Browser)
            .is_err()
    );
    let mut modified = browser.clone();
    modified.push(0);
    assert!(
        build
            .verify_module("c_toy.wasm", &modified, ModuleTarget::Browser)
            .is_err()
    );
    build.verify_authority(b"authority core")?;
    assert!(build.verify_authority(b"another core").is_err());
    Ok(())
}

#[test]
fn matching_hash_does_not_authorize_missing_duplicate_or_wrong_identity() {
    let wrong = wasm("different.sym", 0);
    let missing = wat::parse_str("(module)").unwrap();
    let duplicate = wat::parse_str(
        "(module (@custom \"rm4.module\" \"c_toy.sym\") (@custom \"rm4.module\" \"c_toy.sym\"))",
    )
    .unwrap();
    for bytes in [&wrong[..], &missing, &duplicate, b"not wasm"] {
        let build = parse(&manifest(bytes, bytes)).unwrap();
        for target in [ModuleTarget::Browser, ModuleTarget::Authority] {
            assert!(build.verify_module("c_toy.wasm", bytes, target).is_err());
        }
    }
}

#[test]
fn rejects_invalid_hashes_paths_duplicate_names_and_missing_fields() {
    let value = manifest(b"browser", b"authority");
    for pointer in [
        "/sha256",
        "/authoritySha256",
        "/modules/0/sha256",
        "/modules/0/authoritySha256",
    ] {
        for bad in [
            Value::Null,
            json!(5),
            json!(""),
            json!("a".repeat(63)),
            json!("A".repeat(64)),
            json!("g".repeat(64)),
        ] {
            let mut invalid = value.clone();
            *invalid.pointer_mut(pointer).unwrap() = bad;
            assert!(parse(&invalid).is_err(), "{pointer}: {invalid}");
        }
    }
    for name in [
        "../c_toy.wasm",
        "/c_toy.wasm",
        ".wasm",
        "a.wasm.wasm",
        "c_toy.wasm/",
        "1_car.wasm",
        "A.wasm",
        "a%2f.wasm",
        "a\\b.wasm",
        "",
        &format!("{}.wasm", "a".repeat(121)),
    ] {
        let mut invalid = value.clone();
        invalid["modules"][0]["name"] = name.into();
        assert!(parse(&invalid).is_err(), "{name}");
        assert!(module_symbol(name).is_err(), "{name}");
    }
    for modules in [
        json!([]),
        json!([value["modules"][0], value["modules"][0]]),
        Value::Null,
    ] {
        let mut invalid = value.clone();
        invalid["modules"] = modules;
        assert!(parse(&invalid).is_err());
    }
    for field in ["sha256", "authoritySha256", "modules"] {
        let mut invalid = value.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(parse(&invalid).is_err());
    }
    for field in ["name", "sha256", "authoritySha256"] {
        let mut invalid = value.clone();
        invalid["modules"][0].as_object_mut().unwrap().remove(field);
        assert!(parse(&invalid).is_err());
    }
    assert!(BuildManifest::parse(b"not json").is_err());
}

#[test]
fn filename_mapping_uses_the_registry_name_rules() -> anyhow::Result<()> {
    for stem in ["o_car", "mprobe", "movie_r", "a1", &"a".repeat(120)] {
        let file = format!("{stem}.wasm");
        let symbol = format!("{stem}.sym");
        assert_eq!(module_symbol(&file)?, symbol);
        assert_eq!(module_file(&symbol)?, file);
    }
    for name in ["../o_car.sym", "o_car.wasm", "1.sym", "o_car.sym.sym"] {
        assert!(module_file(name).is_err());
    }
    Ok(())
}
