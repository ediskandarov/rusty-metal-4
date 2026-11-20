use anyhow::{Context, Result, ensure};

fn valid_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".sym") else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= 120
        && stem.bytes().enumerate().all(|(i, byte)| {
            byte.is_ascii_lowercase() || i > 0 && (byte.is_ascii_digit() || byte == b'_')
        })
}
pub fn module_symbol(file: &str) -> Result<String> {
    let stem = file
        .strip_suffix(".wasm")
        .context("Invalid module filename")?;
    let name = format!("{stem}.sym");
    ensure!(valid_name(&name), "Invalid module filename: {file}");
    Ok(name)
}
pub fn module_file(symbol: &str) -> Result<String> {
    ensure!(valid_name(symbol), "Invalid module identity: {symbol}");
    Ok(format!("{}.wasm", symbol.strip_suffix(".sym").unwrap()))
}
fn leb(data: &mut &[u8]) -> Result<usize> {
    let mut value = 0u32;
    for shift in (0..35).step_by(7) {
        let (&byte, rest) = data.split_first().context("Truncated Wasm size")?;
        *data = rest;
        ensure!(shift != 28 || byte <= 15, "Wasm size overflow");
        value |= u32::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Ok(value as usize);
        }
    }
    anyhow::bail!("Invalid Wasm size")
}
pub fn identity(bytes: &[u8]) -> Result<String> {
    ensure!(bytes.starts_with(b"\0asm\x01\0\0\0"), "Invalid Wasm module");
    let mut data = &bytes[8..];
    let mut name = None;
    while !data.is_empty() {
        let id = data[0];
        data = &data[1..];
        let length = leb(&mut data)?;
        ensure!(length <= data.len(), "Truncated Wasm section");
        let (mut section, rest) = data.split_at(length);
        data = rest;
        if id != 0 {
            continue;
        }
        let length = leb(&mut section)?;
        ensure!(length <= section.len(), "Invalid Wasm section name");
        if &section[..length] == b"rm4.module" {
            ensure!(name.is_none(), "Duplicate module identity");
            let value = std::str::from_utf8(&section[length..])?;
            ensure!(valid_name(value), "Invalid module identity");
            name = Some(value.to_owned());
        }
    }
    name.context("Missing rm4.module identity")
}
pub fn original_name(bytes: &[u8]) -> Result<&str> {
    ensure!(bytes.len() >= 20, "Truncated MIPS module");
    let offset = u32::from_le_bytes(bytes[16..20].try_into()?) as usize;
    ensure!(
        offset >= 20 && offset < bytes.len(),
        "Invalid MIPS module offset"
    );
    let tail = &bytes[offset..];
    let end = tail
        .iter()
        .position(|&byte| byte == b'*')
        .context("Missing MIPS module name")?;
    let name = std::str::from_utf8(&tail[..end])?;
    ensure!(valid_name(name), "Invalid MIPS module name");
    Ok(name)
}
