use rm4_mr_preparation::{INDEX_LIMIT, ResourceIndex};

#[test]
fn parsing_and_writing_preserve_original_sectors_until_explicit_repack() -> anyhow::Result<()> {
    let text = "900\t2049\t/DATA/A.MR\n20\t0\t/DATA/MENU/B.TIM\n600\t10\t/DATA/C.IMG\n";
    let mut index = ResourceIndex::parse(text)?;
    assert_eq!(index.to_tsv()?, text);
    index.set_size("/DATA/A.MR", 4097)?;
    assert_eq!(
        index.entries().iter().map(|e| e.sector).collect::<Vec<_>>(),
        [900, 20, 600]
    );
    index.repack(1)?;
    assert_eq!(
        index.to_tsv()?,
        "1\t4097\t/DATA/A.MR\n4\t0\t/DATA/MENU/B.TIM\n5\t10\t/DATA/C.IMG\n"
    );
    Ok(())
}

#[test]
fn paths_are_canonical_and_required_files_are_caller_policy() -> anyhow::Result<()> {
    let mut index = ResourceIndex::parse("10\t5\t/data/main.mr\n20\t10\t/DATA/EXTRA.MR\n")?;
    assert_eq!(
        index.to_tsv()?,
        "10\t5\t/DATA/MAIN.MR\n20\t10\t/DATA/EXTRA.MR\n"
    );
    index.require("/DATA/MAIN.MR", 5)?;
    assert!(index.require("/DATA/MAIN.MR", 6).is_err());
    assert!(index.require("/DATA/MISSING.MR", 0).is_err());
    assert!(index.add("/data/main.mr", 50, 5).is_err());
    assert!(index.set_size("/DATA/MISSING.MR", 5).is_err());
    Ok(())
}

#[test]
fn parser_rejects_ambiguous_paths_and_numbers() {
    for name in [
        "/DATA/../X",
        "/DATA/./X",
        "/DATA//X",
        "/DATA/X/",
        "/DATA/X%20Y",
        "/DATA/X\\Y",
        "/DATA/A B",
        "/DATA/X\0Y",
        "/DATA/X;1",
        "/DATA/é",
        "/DATA/",
        "/X",
    ] {
        assert!(
            ResourceIndex::parse(&format!("1\t1\t{name}\n")).is_err(),
            "{name}"
        );
    }
    assert!(ResourceIndex::parse(&format!("1\t1\t/DATA/{}\n", "X".repeat(250))).is_err());
    for number in ["", "-1", "+1", "1.5", "1e2", "NaN", " 1", "4294967296"] {
        assert!(ResourceIndex::parse(&format!("{number}\t1\t/DATA/A\n")).is_err());
        assert!(ResourceIndex::parse(&format!("1\t{number}\t/DATA/A\n")).is_err());
    }
    for text in [
        "",
        "1\t1\t/DATA/A\textra",
        "1\t1\t/DATA/A\n\n",
        "1\t1\t/DATA/A\n2\t2\t/data/a\n",
    ] {
        assert!(ResourceIndex::parse(text).is_err(), "{text}");
    }
    assert!(ResourceIndex::parse(&" ".repeat(INDEX_LIMIT + 1)).is_err());
}

#[test]
fn address_overflow_does_not_partially_relocate_the_index() -> anyhow::Result<()> {
    let mut index = ResourceIndex::parse("449849\t2048\t/DATA/A\n10\t1\t/DATA/B\n")?;
    let before = index.to_tsv()?;
    assert!(index.repack(449849).is_err());
    assert_eq!(index.to_tsv()?, before);
    assert!(index.repack(u64::MAX).is_err());
    assert_eq!(index.to_tsv()?, before);
    assert!(index.add("/DATA/C", 449850, 0).is_err());
    assert!(index.add("/DATA/C", 449849, 2049).is_err());
    assert!(index.set_size("/DATA/A", u64::from(u32::MAX) + 1).is_err());
    assert_eq!(index.to_tsv()?, before);
    Ok(())
}
