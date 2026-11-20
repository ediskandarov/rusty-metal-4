use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};

pub struct Index {
    pub paths: Vec<String>,
    sizes: BTreeMap<String, u64>,
}
impl Index {
    pub fn new(text: &str) -> Result<Self> {
        let mut paths = Vec::new();
        let mut seen = BTreeSet::new();
        for row in text.lines() {
            let fields: Vec<_> = row.split('\t').collect();
            ensure!(fields.len() == 3, "Invalid resource sector index");
            fields[0]
                .parse::<u64>()
                .context("Invalid resource sector")?;
            fields[1]
                .parse::<u64>()
                .context("Invalid resource length")?;
            let path = fields[2].to_ascii_uppercase();
            let name = path
                .strip_prefix("/DATA/")
                .context("Invalid resource path")?;
            ensure!(
                !name.is_empty()
                    && !name.contains('\\')
                    && name
                        .split('/')
                        .all(|p| !p.is_empty() && p != "." && p != ".."),
                "Invalid resource path"
            );
            ensure!(seen.insert(path.clone()), "Duplicate resource path: {path}");
            paths.push(path);
        }
        ensure!(!paths.is_empty(), "Empty resource sector index");
        Ok(Self {
            paths,
            sizes: BTreeMap::new(),
        })
    }
    pub fn set_size(&mut self, path: &str, size: u64) -> Result<()> {
        ensure!(
            self.paths.iter().any(|p| p == path),
            "Unindexed resource: {path}"
        );
        self.sizes.insert(path.to_owned(), size);
        Ok(())
    }
    pub fn render(&self) -> Result<String> {
        let mut sector = 1u64;
        let mut output = String::new();
        for path in &self.paths {
            let size = self
                .sizes
                .get(path)
                .with_context(|| format!("Missing indexed resource {path}"))?;
            output.push_str(&format!("{sector}\t{size}\t{path}\n"));
            sector = sector
                .checked_add(size.div_ceil(2048).max(1))
                .context("Sector index overflow")?;
        }
        Ok(output)
    }
}
