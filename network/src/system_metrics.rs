//! Linux process and cgroup observations without a shell in the runtime image.
use std::io;

#[cfg(target_os = "linux")]
pub fn read() -> io::Result<String> {
    use std::{fs::File, io::Read};
    fn append(output: &mut String, path: &str) -> io::Result<()> {
        let mut text = String::new();
        File::open(path)?
            .take(64 * 1024)
            .read_to_string(&mut text)?;
        output.push_str(&text);
        if !text.ends_with('\n') {
            output.push('\n');
        }
        Ok(())
    }
    let mut output = String::from("BEGIN\n");
    for path in ["/proc/uptime", "/proc/self/stat", "/proc/self/status"] {
        append(&mut output, path)?;
    }
    output.push_str("CGROUP\n");
    for name in [
        "cpu.stat",
        "cpu.max",
        "memory.current",
        "memory.peak",
        "memory.events",
    ] {
        output.push_str(name);
        output.push('\n');
        match append(&mut output, &format!("/sys/fs/cgroup/{name}")) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    output.push_str("NET\n");
    append(&mut output, "/proc/net/dev")?;
    output.push_str("END\n");
    Ok(output)
}

#[cfg(not(target_os = "linux"))]
pub fn read() -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "System metrics require Linux procfs and cgroup v2",
    ))
}
