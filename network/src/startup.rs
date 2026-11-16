mod args;
use crate::{
    journal,
    management::{MatchSetup, RosterMember, SetupRequest},
    server::{ParticipantRoster, run_match},
    simulator::{self, Simulator},
    web,
};
use args::{Command, ServerOptions};
use std::{env, error::Error, net::SocketAddr, thread, time::Duration};
use tm4_network::protocol::{Catalog, FfaLimits, MAX_PLAYERS, MatchMode};

struct PreparedMatch {
    players: usize,
    world: Option<String>,
    roster: Vec<RosterMember>,
    mode: MatchMode,
    limits: FfaLimits,
    bots: Vec<String>,
    simulator: Simulator,
}
impl PreparedMatch {
    fn from_setup(setup: MatchSetup, simulator: Simulator) -> Self {
        Self {
            players: setup.players,
            world: Some(setup.world),
            roster: setup.roster,
            mode: setup.mode,
            limits: setup.limits,
            bots: setup.bots,
            simulator,
        }
    }
}

pub(crate) fn run() -> Result<(), Box<dyn Error>> {
    match Command::parse(env::args().skip(1), cfg!(feature = "embedded-server"))? {
        Command::Precompile { input, output } => simulator::precompile(&input, &output)?,
        Command::InspectJournal(path) => println!(
            "{}",
            serde_json::to_string_pretty(&journal::inspect(&path)?)?
        ),
        Command::Server(options) => run_server(options)?,
    }
    Ok(())
}

fn prepare_managed(launcher: &web::Launcher) -> Option<PreparedMatch> {
    loop {
        let Some(SetupRequest::Prepare) = launcher.wait_for_setup() else {
            return None;
        };
        match Simulator::from_assets(&launcher.wasm, launcher.resource_directory()) {
            Ok(simulator) => {
                launcher.control.ready(
                    simulator.catalog.worlds.clone(),
                    simulator.catalog.cars.clone(),
                    simulator.compatibility.clone(),
                );
                let Some(SetupRequest::Start(setup)) = launcher.wait_for_setup() else {
                    return None;
                };
                return Some(PreparedMatch::from_setup(setup, simulator));
            }
            Err(error) => launcher
                .control
                .preparation_failed(&format!("Simulator setup failed: {error:#}")),
        }
    }
}

fn prepare_participants(
    count: usize,
    bots: Vec<String>,
    room_roster: &[RosterMember],
    catalog: &Catalog,
) -> Result<ParticipantRoster, Box<dyn Error>> {
    let initial_count = if room_roster.is_empty() {
        count
    } else {
        room_roster.len()
    };
    let mut participants =
        ParticipantRoster::new(MAX_PLAYERS, &(0..initial_count).collect::<Vec<_>>())?;
    for model in bots {
        if !catalog.cars.contains(&model) {
            return Err("Bot model is unavailable".into());
        }
        participants.add_bot(model)?;
    }
    participants.set_human_limit(count)?;
    if !room_roster.is_empty() && !(1..=count).contains(&room_roster.len()) {
        return Err("Room members do not match the prepared participant roster".into());
    }

    Ok(participants)
}

fn run_server(options: ServerOptions) -> Result<(), Box<dyn Error>> {
    let addr: SocketAddr = env::var("TM4_MATCH_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8122".into())
        .parse()?;
    if !addr.ip().is_loopback() && !web::behind_proxy() {
        return Err(
            "Non-loopback WebSocket requires TM4_BEHIND_PROXY=1 and an authenticated HTTPS proxy"
                .into(),
        );
    }
    let launcher = if options.serve {
        Some(web::Launcher::start(options.players, addr)?)
    } else {
        None
    };
    let prepared = if let Some(launcher) = &launcher {
        let Some(prepared) = prepare_managed(launcher) else {
            return Ok(());
        };
        prepared
    } else {
        PreparedMatch {
            players: options.players,
            world: None,
            roster: Vec::new(),
            mode: MatchMode::Ffa,
            limits: Default::default(),
            bots: options.bots,
            simulator: Simulator::from_environment()?,
        }
    };
    let participants = prepare_participants(
        prepared.players,
        prepared.bots,
        &prepared.roster,
        &prepared.simulator.catalog,
    )?;
    // Admission uses participant bindings, never a room-list ordinal as a gameplay slot.
    let room_members = participants
        .human_slots()
        .map(|slot| participants.binding(slot))
        .zip(prepared.roster)
        .collect();
    if let Err(error) = run_match(
        participants,
        prepared.world,
        prepared.mode,
        prepared.limits,
        room_members,
        addr,
        prepared.simulator,
        launcher.as_ref().map(|launcher| &launcher.control),
    ) {
        if let Some(launcher) = &launcher {
            if launcher
                .control
                .stopped
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                return Err(error);
            }
            launcher.control.close(&format!(
                "Match server failed: {error}. Restart the server to try again."
            ));
            while !launcher
                .control
                .stopped
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                thread::sleep(Duration::from_millis(100));
            }
        } else {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn catalog() -> Catalog {
        Catalog {
            cars: vec!["Orbital".into(), "Pizza Boy".into()],
            worlds: vec!["Construction Yard".into()],
        }
    }
    fn room_member() -> RosterMember {
        RosterMember {
            credential: "a".repeat(64),
            car: "Orbital".into(),
        }
    }

    #[test]
    fn room_reservations_and_bot_places_leave_human_capacity_for_late_joiners() {
        let mut roster = prepare_participants(
            6,
            vec!["Pizza Boy".into(), "Orbital".into()],
            &[room_member()],
            &catalog(),
        )
        .unwrap();
        assert_eq!(roster.capacity(), 8);
        assert_eq!(roster.count(), 3);
        assert_eq!(roster.human_slots().collect::<Vec<_>>(), [0]);
        assert!(roster.at_slot(1).original_ai);
        assert_eq!(roster.at_slot(1).car.as_deref(), Some("Pizza Boy"));
        assert!(roster.at_slot(2).original_ai);
        roster.freeze();
        for slot in 3..8 {
            assert_eq!(roster.reserve_live().unwrap().slot, slot);
        }
        assert!(roster.reserve_live().is_err());
    }

    #[test]
    fn standalone_reserves_requested_humans_and_rejects_unavailable_bots() {
        let roster = prepare_participants(2, vec!["Pizza Boy".into()], &[], &catalog()).unwrap();
        assert_eq!(roster.human_slots().collect::<Vec<_>>(), [0, 1]);
        assert!(roster.at_slot(2).original_ai);
        assert!(prepare_participants(1, vec!["Missing".into()], &[], &catalog()).is_err());
        assert!(
            prepare_participants(1, vec![], &[room_member(), room_member()], &catalog()).is_err()
        );
    }
}
