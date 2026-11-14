use crate::{
    journal,
    server::{ParticipantRoster, run_match},
    simulator, web,
};
use std::{env, error::Error, net::SocketAddr, path::Path, thread, time::Duration};
use tm4_network::protocol::MAX_PLAYERS;

pub(crate) fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mut first = args.next().unwrap_or_else(|| {
        if cfg!(feature = "embedded-server") {
            "--serve"
        } else {
            "2"
        }
        .into()
    });
    if first == "--precompile-simulation" {
        let input = args.next().ok_or("Expected source Wasm path")?;
        let output = args.next().ok_or("Expected compiled module path")?;
        if args.next().is_some() {
            return Err("Unexpected precompile argument".into());
        }
        simulator::precompile(Path::new(&input), Path::new(&output))?;
        return Ok(());
    }
    let serve = first == "--serve";
    if serve {
        first = args.next().unwrap_or_else(|| "2".into());
    }
    if first == "--inspect-journal" {
        let path = args.next().ok_or("Expected the journal path")?;
        println!(
            "{}",
            serde_json::to_string_pretty(&journal::inspect(Path::new(&path))?)?
        );
        return Ok(());
    }
    let count: usize = first.parse()?;
    if !(2..=MAX_PLAYERS).contains(&count) {
        return Err("Expected a player count from 2 to 8".into());
    }
    let addr: SocketAddr = env::var("TM4_MATCH_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8122".into())
        .parse()?;

    if !addr.ip().is_loopback() && !web::behind_proxy() {
        return Err(
            "Non-loopback WebSocket requires TM4_BEHIND_PROXY=1 and an authenticated HTTPS proxy"
                .into(),
        );
    }
    let launcher = if serve {
        Some(web::Launcher::start(count, addr)?)
    } else {
        None
    };
    let (count, selected_world, room_roster, simulator) = if let Some(launcher) = &launcher {
        loop {
            let Some(web::SetupRequest::Prepare) = launcher.wait_for_setup() else {
                return Ok(());
            };
            match simulator::Simulator::from_assets(&launcher.wasm, launcher.resource_directory()) {
                Ok(simulator) => {
                    launcher.ready(
                        simulator.catalog.worlds.clone(),
                        simulator.catalog.cars.clone(),
                        simulator.compatibility.clone(),
                    );
                    let Some(web::SetupRequest::Start(setup)) = launcher.wait_for_setup() else {
                        return Ok(());
                    };
                    break (setup.players, Some(setup.world), setup.roster, simulator);
                }
                Err(error) => {
                    launcher.phase("failed", &format!("Simulator setup failed: {error:#}"))
                }
            }
        }
    } else {
        (
            count,
            None,
            Vec::new(),
            simulator::Simulator::from_environment()?,
        )
    };
    let initial_count = if room_roster.is_empty() {
        count
    } else {
        room_roster.len()
    };
    let participants =
        ParticipantRoster::new(MAX_PLAYERS, &(0..initial_count).collect::<Vec<_>>())?;
    if !room_roster.is_empty() && !(2..=count).contains(&room_roster.len()) {
        return Err("Room members do not match the prepared participant roster".into());
    }
    // The mode assigns initial room members once. Admission uses these bindings,
    // never a room-list ordinal as a gameplay slot.
    let room_members = participants
        .slots()
        .map(|slot| participants.binding(slot))
        .zip(room_roster)
        .collect();
    if let Err(error) = run_match(
        participants,
        selected_world,
        room_members,
        addr,
        simulator,
        launcher.as_ref(),
    ) {
        if let Some(launcher) = &launcher {
            launcher.phase(
                "closed",
                &format!("Match server failed: {error}. Restart the server to try again."),
            );
            while !launcher.stopped.load(std::sync::atomic::Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(100));
            }
        } else {
            return Err(error);
        }
    }
    Ok(())
}
