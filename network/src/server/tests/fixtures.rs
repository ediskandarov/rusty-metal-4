use super::super::{ParticipantRoster, run_match};
use crate::{simulator, web};
use std::env;

// Run the production match path with sparse preparation bindings.
// Terminate the fixture process after the browser test completes.
#[test]
#[ignore = "browser fixture; requires private resources and compiled simulation"]
fn sparse_match_browser_fixture() {
    let roster = ParticipantRoster::new(8, &[0, 3, 7]).unwrap();
    run_match(
        roster,
        None,
        Vec::new(),
        env::var("TM4_MATCH_LISTEN").unwrap().parse().unwrap(),
        simulator::Simulator::from_environment().unwrap(),
        None,
    )
    .unwrap();
}

#[test]
#[ignore = "browser fixture; requires private resources and compiled simulation"]
fn sparse_room_match_browser_fixture() {
    let roster = ParticipantRoster::new(8, &[3, 6]).unwrap();
    let members = vec![
        (
            roster.binding(6),
            web::RosterMember {
                credential: "bb".repeat(32),
                car: "Pizza Boy".into(),
            },
        ),
        (
            roster.binding(3),
            web::RosterMember {
                credential: "aa".repeat(32),
                car: "Orbital".into(),
            },
        ),
    ];
    run_match(
        roster,
        None,
        members,
        env::var("TM4_MATCH_LISTEN").unwrap().parse().unwrap(),
        simulator::Simulator::from_environment().unwrap(),
        None,
    )
    .unwrap();
}
