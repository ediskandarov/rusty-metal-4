use crate::module::{identity, original_name};
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeMap, io::Read};

const LIMIT: usize = 64 * 1024 * 1024;
struct Cursor<'a> {
    data: &'a [u8],
    offset: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        ensure!(size <= self.data.len() - self.offset, "Truncated MR entry");
        let value = &self.data[self.offset..self.offset + size];
        self.offset += size;
        Ok(value)
    }
}
fn folder(
    input: &mut Cursor<'_>,
    modules: &mut BTreeMap<String, Vec<u8>>,
    expanded: &mut usize,
    depth: usize,
) -> Result<Vec<u8>> {
    ensure!(depth <= 64, "MR nesting limit exceeded");
    let header = input.take(4)?;
    ensure!(
        header[0] != 0 && header[0] % 4 == 0,
        "Invalid MR folder name"
    );
    let mut output = header.to_vec();
    output.extend_from_slice(input.take(header[0] as usize)?);
    let mut count = u16::from_le_bytes(header[2..4].try_into()?);
    for _ in 0..count {
        let entry = input.take(12)?;
        ensure!(entry[0] != 0 && entry[0] % 4 == 0, "Invalid MR file name");
        let key = input.take(entry[0] as usize)?;
        let stored = u32::from_le_bytes(entry[4..8].try_into()?) as usize;
        let unpacked = u32::from_le_bytes(entry[8..12].try_into()?) as usize;
        *expanded = expanded
            .checked_add(if unpacked != 0 { unpacked } else { stored })
            .context("MR size overflow")?;
        ensure!(*expanded <= LIMIT, "MR expanded size limit exceeded");
        let payload = input.take(stored)?;
        if entry[1] != 6 {
            output.extend_from_slice(entry);
            output.extend_from_slice(key);
            output.extend_from_slice(payload);
            continue;
        }
        let mut decoded = Vec::new();
        let payload = if unpacked == 0 {
            payload
        } else {
            flate2::read::ZlibDecoder::new(payload)
                .take(unpacked as u64 + 1)
                .read_to_end(&mut decoded)?;
            ensure!(
                decoded.len() == unpacked,
                "Invalid compressed module length"
            );
            &decoded
        };
        let wasm = if payload.starts_with(b"\0asm") {
            let name = identity(payload)?;
            if let Some(previous) = modules.get(&name) {
                ensure!(previous == payload, "Conflicting module identity: {name}");
            } else {
                modules.insert(name, payload.to_vec());
            }
            payload
        } else {
            let name = original_name(payload)?;
            if name == "movie_r.sym" {
                count -= 1;
                continue;
            }
            modules
                .get(name)
                .with_context(|| format!("Missing resource module {name}"))?
        };
        let mut entry = entry.to_vec();
        entry[4..8].copy_from_slice(&u32::try_from(wasm.len())?.to_le_bytes());
        entry[8..12].fill(0);
        output.extend_from_slice(&entry);
        output.extend_from_slice(key);
        output.extend_from_slice(wasm);
        ensure!(output.len() <= LIMIT, "Prepared MR exceeds size limit");
    }
    output[2..4].copy_from_slice(&count.to_le_bytes());
    for _ in 0..header[1] {
        output.extend(folder(input, modules, expanded, depth + 1)?);
    }
    ensure!(output.len() <= LIMIT, "Prepared MR exceeds size limit");
    Ok(output)
}
pub fn archive(bytes: &[u8], modules: &mut BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let mut input = Cursor {
        data: bytes,
        offset: 0,
    };
    let signature = input.take(4)?;
    ensure!(
        signature == [0x67, 0, 0, 0] || signature == [0x67, 0, 0xcc, 0xcc],
        "Invalid MR signature"
    );
    let mut output = signature.to_vec();
    output.extend(folder(&mut input, modules, &mut 0, 0)?);
    ensure!(
        bytes[input.offset..]
            .iter()
            .all(|b| matches!(b, 0 | 0xcc | 0xcd | 0xfd)),
        "Unexpected MR trailer"
    );
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::identity;
    fn wasm(name: &str) -> Vec<u8> {
        wat::parse_str(format!("(module (@custom \"rm4.module\" \"{name}\"))")).unwrap()
    }
    fn mr(payload: &[u8], compressed: bool) -> Vec<u8> {
        use std::io::Write;
        let stored = if compressed {
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(payload).unwrap();
            encoder.finish().unwrap()
        } else {
            payload.to_vec()
        };
        let mut bytes = vec![0x67, 0, 0, 0, 8, 0, 1, 0];
        bytes.extend_from_slice(b"Root\0\0\0\0");
        bytes.extend_from_slice(&[8, 6, 255, 255]);
        bytes.extend_from_slice(&(stored.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(if compressed { payload.len() as u32 } else { 0 }).to_le_bytes());
        bytes.extend_from_slice(b"x\x85.mod\0\0");
        bytes.extend(stored);
        bytes
    }
    #[test]
    fn replaces_compressed_mips_and_collects_authored_wasm() -> Result<()> {
        let mut descriptor = vec![0; 20];
        descriptor[16..20].copy_from_slice(&20u32.to_le_bytes());
        descriptor.extend_from_slice(b"o_car.sym*");
        let compiled = wasm("o_car.sym");
        let mut modules = BTreeMap::from([("o_car.sym".into(), compiled.clone())]);
        assert_eq!(
            archive(&mr(&descriptor, true), &mut modules)?,
            mr(&compiled, false)
        );
        let authored = wasm("mprobe.sym");
        assert_eq!(
            archive(&mr(&authored, false), &mut modules)?,
            mr(&authored, false)
        );
        assert_eq!(modules.get("mprobe.sym"), Some(&authored));
        assert!(archive(&mr(&descriptor, false), &mut BTreeMap::new()).is_err());
        Ok(())
    }
    #[test]
    fn rejects_conflicts_truncation_and_invalid_identity() -> Result<()> {
        let image = wasm("mprobe.sym");
        let archive_bytes = mr(&image, false);
        let mut modules = BTreeMap::from([("mprobe.sym".into(), vec![1, 2, 3])]);
        assert!(archive(&archive_bytes, &mut modules).is_err());
        for end in 0..archive_bytes.len() {
            assert!(
                archive(&archive_bytes[..end], &mut BTreeMap::new()).is_err(),
                "accepted truncation {end}"
            );
        }
        assert!(identity(&wasm("../bad.sym")).is_err());
        assert!(identity(b"\0asm\x01\0\0\0").is_err());
        Ok(())
    }
}
