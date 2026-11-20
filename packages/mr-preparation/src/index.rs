use anyhow::{Context, Result, ensure};
use std::collections::BTreeMap;
use std::fmt::Write;

pub const INDEX_LIMIT: usize = 128 * 1024;
// CdlLOC stores two BCD minute digits and adds the 150-sector lead-in.
const SECTOR_LIMIT: u64 = 100 * 60 * 75 - 150;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceEntry {
    pub path: String,
    pub sector: u32,
    pub size: u32,
}

#[derive(Clone, Default)]
pub struct ResourceIndex {
    entries: Vec<ResourceEntry>,
    positions: BTreeMap<String, usize>,
}

fn path(value: &str) -> Result<String> {
    ensure!(
        value.len() < 256
            && value.is_ascii()
            && !value
                .bytes()
                .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
            && !value.contains(['%', '\\', ';']),
        "Invalid resource index path"
    );
    let value = value.to_ascii_uppercase();
    let tail = value
        .strip_prefix("/DATA/")
        .context("Invalid resource index path")?;
    ensure!(
        tail.split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".."),
        "Invalid resource index path"
    );
    Ok(value)
}

fn number(text: &str) -> Result<u32> {
    ensure!(
        !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
        "Invalid resource index number"
    );
    text.parse().context("Resource index number exceeds u32")
}
fn end(sector: u64, size: u32) -> Result<u64> {
    let end = sector
        .checked_add(u64::from(size).div_ceil(2048).max(1))
        .context("Sector index overflow")?;
    ensure!(end <= SECTOR_LIMIT, "Virtual CD address capacity exceeded");
    Ok(end)
}

impl ResourceIndex {
    pub fn parse(text: &str) -> Result<Self> {
        ensure!(
            text.len() <= INDEX_LIMIT,
            "Resource index exceeds size limit"
        );
        let mut index = Self::default();
        for row in text.lines() {
            let fields: Vec<_> = row.split('\t').collect();
            ensure!(fields.len() == 3, "Invalid resource sector index row");
            index.add(
                fields[2],
                u64::from(number(fields[0])?),
                u64::from(number(fields[1])?),
            )?;
        }
        ensure!(!index.entries.is_empty(), "Empty resource sector index");
        Ok(index)
    }
    pub fn entries(&self) -> &[ResourceEntry] {
        &self.entries
    }
    pub fn add(&mut self, name: &str, sector: u64, size: u64) -> Result<()> {
        let name = path(name)?;
        let size = u32::try_from(size).context("Resource length exceeds u32")?;
        let sector = u32::try_from(sector).context("Resource sector exceeds u32")?;
        end(u64::from(sector), size)?;
        ensure!(
            !self.positions.contains_key(&name),
            "Duplicate resource path: {name}"
        );
        self.positions.insert(name.clone(), self.entries.len());
        self.entries.push(ResourceEntry {
            path: name,
            sector,
            size,
        });
        Ok(())
    }
    fn position(&self, name: &str) -> Result<usize> {
        self.positions
            .get(&path(name)?)
            .copied()
            .with_context(|| format!("Missing indexed resource {name}"))
    }
    pub fn set_size(&mut self, name: &str, size: u64) -> Result<()> {
        let position = self.position(name)?;
        let size = u32::try_from(size).context("Resource length exceeds u32")?;
        self.entries[position].size = size;
        Ok(())
    }
    pub fn require(&self, name: &str, size: u64) -> Result<()> {
        let entry = &self.entries[self.position(name)?];
        ensure!(
            u64::from(entry.size) == size,
            "Resource index size differs: {name}"
        );
        Ok(())
    }
    /// Preserve row order and sizes; commit new sector locations only if all fit.
    pub fn repack(&mut self, first_sector: u64) -> Result<()> {
        let mut sector = first_sector;
        let mut sectors = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            let next = end(sector, entry.size)?;
            sectors.push(u32::try_from(sector)?);
            sector = next;
        }
        for (entry, sector) in self.entries.iter_mut().zip(sectors) {
            entry.sector = sector;
        }
        Ok(())
    }
    /// Serialization alone never changes sectors.
    pub fn to_tsv(&self) -> Result<String> {
        ensure!(!self.entries.is_empty(), "Empty resource sector index");
        let mut output = String::new();
        for entry in &self.entries {
            end(u64::from(entry.sector), entry.size)?;
            writeln!(output, "{}\t{}\t{}", entry.sector, entry.size, entry.path)?;
            ensure!(
                output.len() <= INDEX_LIMIT,
                "Resource index exceeds size limit"
            );
        }
        Ok(output)
    }
}
