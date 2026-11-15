#![cfg(all(unix, feature = "server"))]

use std::{
    fs,
    io::{BufRead, BufReader},
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

struct Server {
    child: Child,
    directory: PathBuf,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn sigterm_exits_successfully_and_removes_private_resources() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let directory = std::env::temp_dir().join(format!(
        "rm4-shutdown-{}-{}",
        std::process::id(),
        address.port()
    ));
    fs::create_dir(&directory).unwrap();
    drop(listener);
    let child = Command::new(env!("CARGO_BIN_EXE_tm4-deathmatch-server"))
        .args(["--serve", "2"])
        .env("TM4_HTTP_LISTEN", address.to_string())
        .env("TM4_MATCH_LISTEN", "127.0.0.1:0")
        .env("TM4_ADMIN_SECRET", "shutdown-test-private-secret")
        .env("TMPDIR", &directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut server = Server { child, directory };
    let stdout = server.child.stdout.take().unwrap();
    let (ready, wait) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.unwrap().starts_with("Server launcher:") {
                let _ = ready.send(());
            }
        }
    });
    wait.recv_timeout(Duration::from_secs(10))
        .expect("server startup");
    assert_eq!(fs::read_dir(&server.directory).unwrap().count(), 1);
    assert!(
        Command::new("kill")
            .args(["-TERM", &server.child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "SIGTERM did not stop the server");
        thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "server exited with {status}");
    reader.join().unwrap();
    assert_eq!(fs::read_dir(&server.directory).unwrap().count(), 0);
    TcpListener::bind(address).expect("HTTP listener released");
}
