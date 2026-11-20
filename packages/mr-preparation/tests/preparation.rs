use rm4_mr_preparation::Preparation;

#[test]
fn index_keeps_order_and_uses_prepared_lengths() -> anyhow::Result<()> {
    let mut prep =
        Preparation::new("90\t1\t/DATA/MENU/A.MR\n95\t2\t/DATA/X.IMG\n100\t3\t/DATA/EMPTY.MR\n")?;
    assert_eq!(
        prep.paths(),
        ["/DATA/MENU/A.MR", "/DATA/X.IMG", "/DATA/EMPTY.MR"]
    );
    assert!(prep.index().is_err());
    prep.set_size("/DATA/MENU/A.MR", 2049)?;
    prep.set_size("/DATA/X.IMG", 0)?;
    prep.set_size("/DATA/EMPTY.MR", 19)?;
    assert_eq!(
        prep.index()?,
        "1\t2049\t/DATA/MENU/A.MR\n3\t0\t/DATA/X.IMG\n4\t19\t/DATA/EMPTY.MR\n"
    );
    assert!(prep.set_size("/DATA/UNLISTED.MR", 4).is_err());
    Ok(())
}

#[test]
fn index_rejects_unsafe_paths_duplicates_and_malformed_rows() {
    for path in [
        "/ELSE/X.MR",
        "/DATA/../X.MR",
        "/DATA/./X.MR",
        "/DATA//X.MR",
        "/DATA/",
        "/DATA/A\\X.MR",
    ] {
        assert!(
            Preparation::new(&format!("1\t1\t{path}\n")).is_err(),
            "{path}"
        );
    }
    for text in [
        "",
        "1\t1\n",
        "x\t1\t/DATA/A.MR\n",
        "1\tx\t/DATA/A.MR\n",
        "1\t1\t/DATA/A.MR\n2\t1\t/DATA/a.mr\n",
    ] {
        assert!(Preparation::new(text).is_err(), "{text}");
    }
}

#[test]
fn inventory_requires_matching_unique_module_identity() -> anyhow::Result<()> {
    let mut prep = Preparation::new("1\t1\t/DATA/A.MR\n")?;
    let module = wat::parse_str("(module (@custom \"rm4.module\" \"probe.sym\"))")?;
    assert!(prep.add_module("different.sym", module.clone()).is_err());
    prep.add_module("probe.sym", module.clone())?;
    assert!(prep.add_module("probe.sym", module.clone()).is_err());
    assert_eq!(prep.into_modules().get("probe.sym"), Some(&module));
    Ok(())
}
