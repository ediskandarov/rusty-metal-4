use super::super::control::{
    accept_native_inputs, bind_controllers, detach_connection, reap_closed_links,
};
use super::super::tick::update;
use super::super::*;
use crate::simulator;
use bevy_ecs::system::RunSystemOnce;
use lightyear::prelude::input::native::{ActionState, NativeBuffer};
use std::env;
use tm4_network::protocol::{ParticipantId, Score};
use tm4_network::{
    input::ControllerCommand,
    protocol::{ControllerIdentity, MAX_PLAYERS, Request},
};

fn game() -> Match {
    let compatibility = Compatibility {
        protocol: game_protocol::PROTOCOL_VERSION,
        build: "test".into(),
        content: "test".into(),
    };
    Match {
        participants: ParticipantRoster::new(2, &[0, 1]).unwrap(),
        membership: Default::default(),
        room_requests: None,
        controls: (0..2).map(|_| ControllerState::default()).collect(),
        authority_ready: true,
        compatibility: Some(compatibility.clone()),
        catalog: Some(Catalog {
            cars: vec!["Orbital".into(), "Pizza Boy".into()],
            worlds: vec!["Construction Yard".into()],
        }),
        selected_world: None,
        limits: Default::default(),
        room_only: false,
        retired_connections: HashSet::new(),
        initial_digest: Some(123),
        started: true,
        ended: false,
        tick: 100,
        lobby_since: None,
        loading_since: Instant::now(),
        last_step_duration: None,
        session: Some(SessionStart {
            mode: tm4_network::protocol::MatchMode::Ffa,
            limits: tm4_network::protocol::FfaLimits::default(),
            respawn_delay_ticks: tm4_network::protocol::ffa_respawn_delay_ticks(),
            model_pool: vec!["Orbital".into(), "Pizza Boy".into()],
            capacity: 8,
            slots: (0..2).map(|slot| slot as u8).collect(),
            participants: vec![ParticipantId(1), ParticipantId(2)],
            world: "Construction Yard".into(),
            cars: vec!["Orbital".into(), "Pizza Boy".into()],
            compatibility,
            seed: 12345,
            epoch: 1,
            portable: true,
        }),
        last_state: Some(RoundState {
            completion: tm4_network::protocol::MatchCompletion {
                tick: 0,
                reasons: 0,
                winners: 0,
            },
            remaining: 2,
            winner: -1,
            round_finished: false,
            accepts_continue: false,
            next_mode: 0,
            digest: 123,
            sections: [0; 5],
            unsupported: None,
            scores: vec![
                Score {
                    frags: 3,
                    deaths: 1,
                },
                Score {
                    frags: 0,
                    deaths: 3,
                },
            ],
        }),
        journal_directory: PathBuf::new(),
        journal: None,
        journal_sealed: false,
        journal_export: Default::default(),
        prediction: {
            let mut prediction = AcceptedTimeline::default();
            prediction.anchor = Some(Tick(1));
            prediction
        },
        next_resume: 0,
        health: Default::default(),
        tick_schedule: None,
    }
}

fn connection(world: &mut World, id: u64) -> Entity {
    world
        .spawn((
            RemoteId(PeerId::Netcode(id)),
            Connected,
            MessageSender::<Message>::default(),
        ))
        .id()
}

fn request(world: &mut World, entity: Entity, request: Request) {
    let mut request = Some(request);
    world.run_system_once(move |mut game: ResMut<Match>, mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>| {
        game.request(&mut links, entity, request.take().unwrap());
    }).unwrap();
}

fn bind(world: &mut World) {
    world
        .run_system_once(
            |mut game: ResMut<Match>, owners: Query<&ControlledBy>, mut commands: Commands| {
                bind_controllers(&mut game, &owners, &mut commands);
            },
        )
        .unwrap();
}

fn buffer(sequence: u32, buttons: u16) -> NativeBuffer<ControllerCommand> {
    let mut buffer = NativeBuffer::default();
    buffer.set(
        Tick(101),
        ActionState(ControllerCommand {
            epoch: 1,
            sequence,
            tick: 100,
            input: Input {
                buttons,
                ..Default::default()
            },
        }),
    );
    buffer
}

#[test]
#[ignore = "requires private resources and diagnostic Wasm"]
fn preparation_cancellation_allows_the_ready_single_participant_to_start() -> anyhow::Result<()> {
    let mut world = World::new();
    let mut game = game();
    game.participants = ParticipantRoster::new(MAX_PLAYERS, &[0, 1]).unwrap();
    game.controls
        .resize_with(MAX_PLAYERS, ControllerState::default);
    game.started = false;
    game.tick = 0;
    game.session = None;
    game.initial_digest = None;
    game.last_state = None;
    game.prediction = Default::default();
    let compatibility = game.compatibility.clone().unwrap();
    let wasm = std::fs::read(env::var("TM4_SIMULATION_WASM")?)?;
    let resources = PathBuf::from(env::var("TM4_RESOURCE_DIR")?);
    let simulator = simulator::Simulator::new(&wasm, &resources, compatibility.clone())?;
    world.insert_non_send(simulator);
    world.insert_resource(LocalTimeline::default());
    world.insert_resource(game);
    world
        .run_system_once(|mut game: ResMut<Match>, mut commands: Commands| {
            for slot in [0, 1] {
                let binding = game.participants.binding(slot);
                game.release_preparation(binding, &mut commands).unwrap();
            }
        })
        .unwrap();
    world.run_system_once(update).unwrap();
    assert!(!world.resource::<Match>().started);
    assert!(!world.resource::<Match>().ended);
    assert!(world.resource::<Match>().session.is_none());

    // A reserved unready participant blocks start; releasing it allows solo FFA.
    for slot in [0, 1] {
        world
            .resource_mut::<Match>()
            .reserve_preparation(slot)
            .unwrap();
    }
    let first = connection(&mut world, 71);
    request(
        &mut world,
        first,
        Request::Join {
            compatibility: compatibility.clone(),
        },
    );
    request(
        &mut world,
        first,
        Request::SelectCar {
            car: "Orbital".into(),
            ready: true,
        },
    );
    world
        .run_system_once(|mut game: ResMut<Match>, mut commands: Commands| {
            let binding = game.participants.binding(1);
            game.release_preparation(binding, &mut commands).unwrap();
        })
        .unwrap();
    world.run_system_once(update).unwrap();
    let game = world.resource::<Match>();
    assert!(game.started && !game.ended);
    assert_eq!(game.session.as_ref().unwrap().slots, vec![0]);
    assert!(game.initial_digest.is_some());
    assert_eq!(
        world
            .non_send_mut::<simulator::Simulator>()
            .state()?
            .remaining,
        1
    );
    Ok(())
}

#[test]
fn session_start_requires_explicit_recovery_capability() {
    let session = game().session.unwrap();
    let mut encoded = serde_json::to_value(session).unwrap();
    for portable in [true, false] {
        encoded["portable"] = serde_json::json!(portable);
        let decoded: SessionStart = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(decoded.portable, portable);
    }
    encoded.as_object_mut().unwrap().remove("portable");
    assert!(serde_json::from_value::<SessionStart>(encoded).is_err());
}

#[test]
fn stale_resume_does_not_join_an_open_lobby() {
    let mut world = World::new();
    let client = connection(&mut world, 1);
    let mut game = game();
    game.started = false;
    game.session = None;
    let compatibility = game.compatibility.clone().unwrap();
    let binding = game.participants.binding(0);
    world.insert_resource(game);
    request(
        &mut world,
        client,
        Request::Resume {
            token: "aa".repeat(32),
            compatibility: compatibility.clone(),
        },
    );
    bind(&mut world);
    let game = world.resource::<Match>();
    assert!(game.controls.iter().all(|control| {
        control.connection.is_none()
            && control.controller.is_none()
            && control.compatibility.is_none()
    }));
    assert_eq!(game.participants.binding(0), binding);
    request(&mut world, client, Request::Join { compatibility });
    bind(&mut world);
    let game = world.resource::<Match>();
    assert_eq!(game.controls[0].connection, Some(client));
    assert!(game.controls[0].controller.is_some());
    assert_eq!(game.participants.binding(0), binding);
}

#[test]
fn room_admission_and_preparation_reconnect_use_participant_bindings() {
    let mut world = World::new();
    let first = connection(&mut world, 3);
    let second = connection(&mut world, 6);
    let reconnect = connection(&mut world, 33);
    let mut game = game();
    game.started = false;
    game.participants = ParticipantRoster::new(8, &[3, 6]).unwrap();
    game.controls = (0..8).map(|_| ControllerState::default()).collect();
    let a = game.participants.binding(3);
    let b = game.participants.binding(6);
    game.configure_room(vec![
        (
            b,
            web::RosterMember {
                credential: "bb".repeat(32),
                car: "Pizza Boy".into(),
            },
        ),
        (
            a,
            web::RosterMember {
                credential: "aa".repeat(32),
                car: "Orbital".into(),
            },
        ),
    ])
    .unwrap();
    let compatibility = game.compatibility.clone().unwrap();
    world.insert_resource(game);
    request(
        &mut world,
        second,
        Request::Resume {
            token: "bb".repeat(32),
            compatibility: compatibility.clone(),
        },
    );
    request(
        &mut world,
        first,
        Request::Resume {
            token: "aa".repeat(32),
            compatibility: compatibility.clone(),
        },
    );
    bind(&mut world);
    assert_eq!(
        world.resource::<Match>().controls[3].connection,
        Some(first)
    );
    assert_eq!(
        world.resource::<Match>().controls[6].connection,
        Some(second)
    );
    let controller = world.resource::<Match>().controls[3].controller.unwrap();
    assert_eq!(world.get::<ControllerIdentity>(controller), Some(&a));
    world.resource_mut::<Match>().controls[3].received_sequence = 41;
    world
        .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
            detach_connection(&mut game, 3, first, &mut commands);
        })
        .unwrap();
    request(
        &mut world,
        reconnect,
        Request::Resume {
            token: "aa".repeat(32),
            compatibility,
        },
    );
    bind(&mut world);
    let game = world.resource::<Match>();
    assert_eq!(game.controls[3].connection, Some(reconnect));
    assert_eq!(game.controls[3].controller, Some(controller));
    assert_eq!(game.controls[3].received_sequence, 41);
    assert_eq!(game.participants.binding(3), a);
    assert_eq!(
        world.get::<ControlledBy>(controller).unwrap().owner,
        reconnect
    );
}

#[test]
fn preparation_reuse_retires_existing_controller_connection_and_input() {
    let mut world = World::new();
    let old = connection(&mut world, 1);
    let other = connection(&mut world, 2);
    let newcomer = connection(&mut world, 3);
    let mut game = game();
    game.started = false;
    game.controls[0].connection = Some(old);
    game.controls[1].connection = Some(other);
    game.controls[0].received_sequence = 41;
    game.controls[0]
        .history
        .enqueue(
            100,
            41,
            100,
            Input {
                buttons: 0x40,
                ..Default::default()
            },
        )
        .unwrap();
    game.prediction.accepted[0].set(
        Tick(101),
        ActionState(Input {
            buttons: 0x40,
            ..Default::default()
        }),
    );
    let retired = game.participants.binding(0);
    let unaffected = game.participants.binding(1);
    let compatibility = game.compatibility.clone().unwrap();
    world.insert_resource(game);
    bind(&mut world);
    let old_controller = world.resource::<Match>().controls[0].controller.unwrap();
    world.entity_mut(old_controller).insert(buffer(42, 0x40));
    world
        .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
            game.replace_preparation(retired, &mut commands).unwrap();
        })
        .unwrap();
    bind(&mut world);
    assert!(world.get_entity(old_controller).is_err());
    {
        let mut game = world.resource_mut::<Match>();
        assert_eq!(game.controls[0].connection, None);
        assert_eq!(game.controls[0].controller, None);
        assert_eq!(game.controls[0].received_sequence, 0);
        assert_eq!(game.controls[0].history.sample(100), Input::default());
        assert_eq!(game.prediction.accepted[0].len(), 0);
        assert_ne!(game.participants.binding(0), retired);
        assert_eq!(game.participants.binding(1), unaffected);
    }
    request(
        &mut world,
        old,
        Request::SelectCar {
            car: "Pizza Boy".into(),
            ready: true,
        },
    );
    assert!(
        world
            .resource::<Match>()
            .participants
            .at_slot(0)
            .car
            .is_none()
    );
    request(
        &mut world,
        old,
        Request::Join {
            compatibility: compatibility.clone(),
        },
    );
    assert_eq!(
        world.resource::<Match>().controls[0].connection,
        None,
        "A stale Join on the retired connection reclaimed the replacement binding"
    );
    request(&mut world, newcomer, Request::Join { compatibility });
    bind(&mut world);
    let game = world.resource::<Match>();
    let current = game.controls[0].controller.unwrap();
    assert_ne!(current, old_controller);
    assert_eq!(game.controls[0].connection, Some(newcomer));
    assert_eq!(
        world.get::<ControllerIdentity>(current),
        Some(&game.participants.binding(0))
    );
    assert_eq!(world.get::<ControlledBy>(current).unwrap().owner, newcomer);
}

#[test]
fn retired_room_credential_cannot_claim_a_reused_slot_and_running_release_is_fenced() {
    let mut world = World::new();
    let old = connection(&mut world, 1);
    let mut game = game();
    game.started = false;
    let retired = game.participants.binding(0);
    game.configure_room(vec![
        (
            retired,
            web::RosterMember {
                credential: "aa".repeat(32),
                car: "Orbital".into(),
            },
        ),
        (
            game.participants.binding(1),
            web::RosterMember {
                credential: "bb".repeat(32),
                car: "Pizza Boy".into(),
            },
        ),
    ])
    .unwrap();
    let compatibility = game.compatibility.clone().unwrap();
    world.insert_resource(game);
    request(
        &mut world,
        old,
        Request::Resume {
            token: "aa".repeat(32),
            compatibility: compatibility.clone(),
        },
    );
    bind(&mut world);
    world
        .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
            game.replace_preparation(retired, &mut commands).unwrap();
        })
        .unwrap();
    request(
        &mut world,
        old,
        Request::Resume {
            token: "aa".repeat(32),
            compatibility,
        },
    );
    assert_eq!(world.resource::<Match>().controls[0].connection, None);
    world.resource_mut::<Match>().started = true;
    world
        .run_system_once(|mut game: ResMut<Match>, mut commands: Commands| {
            let current = game.participants.binding(0);
            assert!(game.release_preparation(current, &mut commands).is_err());
            assert_eq!(game.participants.resolve(&current), Some(0));
        })
        .unwrap();
}

#[test]
fn reused_sparse_slot_rejects_previous_owner_and_accepts_slot_seven() {
    let mut world = World::new();
    let owner = connection(&mut world, 7);
    let mut game = game();
    game.participants = ParticipantRoster::new(8, &[0, 3, 7]).unwrap();
    game.controls = (0..8).map(|_| ControllerState::default()).collect();
    let retired = game.participants.binding(7);
    game.started = false;
    world.insert_resource(game);
    world
        .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
            game.replace_preparation(retired, &mut commands).unwrap();
        })
        .unwrap();
    let current = world.resource::<Match>().participants.binding(7);
    world.resource_mut::<Match>().controls[7].connection = Some(owner);
    world.resource_mut::<Match>().started = true;
    bind(&mut world);
    let controller = world.resource::<Match>().controls[7].controller.unwrap();
    world
        .entity_mut(controller)
        .insert((retired, buffer(1, 0x40)));
    world.run_system_once(accept_native_inputs).unwrap();
    assert_eq!(world.resource::<Match>().controls[7].received_sequence, 0);
    world
        .entity_mut(controller)
        .insert((current, buffer(1, 0x40)));
    world.run_system_once(accept_native_inputs).unwrap();
    assert_eq!(
        world.resource_mut::<Match>().controls[7]
            .history
            .sample(100)
            .buttons,
        0x40
    );
    assert!(
        world
            .resource::<Match>()
            .controls
            .iter()
            .enumerate()
            .filter(|(slot, _)| *slot != 7)
            .all(|(_, control)| control.received_sequence == 0)
    );
}

#[test]
fn reconnect_keeps_binding_results_and_watermark_and_fences_the_old_connection() {
    let mut world = World::new();
    let old = connection(&mut world, 1);
    let replacement = connection(&mut world, 2);
    let duplicate = connection(&mut world, 3);
    let mut game = game();
    game.controls[0].connection = Some(old);
    game.controls[0].received_sequence = 41;
    let token = "ab".repeat(32);
    game.participants.at_slot_mut(0).credential = Some(token.clone());
    game.participants.at_slot_mut(0).car = Some("Orbital".into());
    let binding = game.participants.binding(0);
    let compatibility = game.compatibility.clone().unwrap();
    world.insert_resource(game);
    bind(&mut world);
    let controller = world.resource::<Match>().controls[0].controller.unwrap();
    // Native records not consumed before disconnect must not enter the new
    // connection's command stream, even if they carry a larger sequence.
    world.entity_mut(controller).insert(buffer(999, 99));
    world.resource_mut::<Match>().controls[0].disconnect(old);
    world.entity_mut(old).remove::<Connected>();
    request(
        &mut world,
        old,
        Request::Resume {
            token: token.clone(),
            compatibility: compatibility.clone(),
        },
    );
    assert!(world.resource::<Match>().controls[0].connection.is_none());
    request(
        &mut world,
        replacement,
        Request::Resume {
            token: "cd".repeat(32),
            compatibility: compatibility.clone(),
        },
    );
    assert!(world.resource::<Match>().controls[0].connection.is_none());
    let mut incompatible = compatibility.clone();
    incompatible.build = "other".into();
    request(
        &mut world,
        replacement,
        Request::Resume {
            token: token.clone(),
            compatibility: incompatible,
        },
    );
    assert!(world.resource::<Match>().controls[0].connection.is_none());
    request(
        &mut world,
        replacement,
        Request::Resume {
            token: token.clone(),
            compatibility: compatibility.clone(),
        },
    );
    bind(&mut world);
    assert!(
        world
            .get::<NativeBuffer<ControllerCommand>>(controller)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        world.get::<ControlledBy>(controller).unwrap().owner,
        replacement
    );
    {
        let game = world.resource::<Match>();
        assert_eq!(game.participants.binding(0), binding);
        assert_eq!(game.controls[0].controller, Some(controller));
        assert_eq!(game.controls[0].received_sequence, 41);
        assert_eq!(game.participants.at_slot(0).car.as_deref(), Some("Orbital"));
        assert_eq!(game.last_state.as_ref().unwrap().scores[0].frags, 3);
    }
    request(
        &mut world,
        duplicate,
        Request::Resume {
            token,
            compatibility,
        },
    );
    assert_eq!(
        world.resource::<Match>().controls[0].connection,
        Some(replacement)
    );
    // Delayed disconnect and session messages from the old link cannot
    // evict or advance the replacement's recovery attempt.
    assert!(!world.resource_mut::<Match>().controls[0].disconnect(old));
    request(&mut world, old, Request::Progress { tick: 100 });
    assert_eq!(world.resource::<Match>().controls[0].progress_tick, 0);
    let server = world.spawn_empty().id();
    world.entity_mut(old).insert((
        LinkOf { server },
        Unlinked {
            reason: UnlinkReason::ByPeer("delayed close".into()),
        },
    ));
    world.run_system_once(reap_closed_links).unwrap();
    assert_eq!(
        world.get::<ControlledBy>(controller).unwrap().owner,
        replacement
    );
    // Restore activation is unchanged; the next command must still exceed
    // the original participant's high-water mark.
    world.resource_mut::<Match>().controls[0].resume = None;
    world.entity_mut(controller).insert(buffer(41, 7));
    world.run_system_once(accept_native_inputs).unwrap();
    assert_eq!(
        world.resource_mut::<Match>().controls[0]
            .history
            .sample(100),
        Input::default()
    );
    world.entity_mut(controller).insert(buffer(42, 8));
    world.run_system_once(accept_native_inputs).unwrap();
    assert_eq!(
        world.resource_mut::<Match>().controls[0]
            .history
            .sample(100)
            .buttons,
        8
    );
}

#[test]
fn input_requires_the_current_participant_controller_and_connected_owner() {
    let mut world = World::new();
    let owner = connection(&mut world, 1);
    let other = connection(&mut world, 2);
    let mut game = game();
    // The other tests exercise replacement through the preparation operation.
    game.controls[0].connection = Some(owner);
    world.insert_resource(game);
    bind(&mut world);
    let controller = world.resource::<Match>().controls[0].controller.unwrap();
    let identity = world.resource::<Match>().participants.binding(0);
    let wrong = world
        .resource::<Match>()
        .participants
        .binding(1)
        .participant;
    for invalid in [
        ControllerIdentity {
            participant: ParticipantId(999),
            ..identity
        },
        ControllerIdentity {
            participant: wrong,
            ..identity
        },
        ControllerIdentity {
            slot: 255,
            ..identity
        },
    ] {
        world.entity_mut(controller).insert((invalid, buffer(1, 9)));
        world.run_system_once(accept_native_inputs).unwrap();
        assert_eq!(world.resource::<Match>().controls[0].received_sequence, 0);
    }
    world.entity_mut(controller).insert((
        identity,
        ControlledBy {
            owner: other,
            lifetime: Lifetime::Persistent,
        },
    ));
    world.run_system_once(accept_native_inputs).unwrap();
    assert_eq!(world.resource::<Match>().controls[0].received_sequence, 0);
    world.entity_mut(controller).insert(ControlledBy {
        owner,
        lifetime: Lifetime::Persistent,
    });
    // A second entity cannot borrow a valid participant binding.
    let forged = world
        .spawn((
            identity,
            ControlledBy {
                owner,
                lifetime: Lifetime::Persistent,
            },
            buffer(999, 9),
        ))
        .id();
    world
        .entity_mut(controller)
        .insert(NativeBuffer::<ControllerCommand>::default());
    world.run_system_once(accept_native_inputs).unwrap();
    assert_eq!(world.resource::<Match>().controls[0].received_sequence, 0);
    world.despawn(forged);
    world.entity_mut(owner).remove::<Connected>();
    world.entity_mut(controller).insert(buffer(1, 9));
    world.run_system_once(accept_native_inputs).unwrap();
    assert_eq!(world.resource::<Match>().controls[0].received_sequence, 0);
    world.entity_mut(owner).insert(Connected);
    world.run_system_once(accept_native_inputs).unwrap();
    assert_eq!(
        world.resource_mut::<Match>().controls[0]
            .history
            .sample(100)
            .buttons,
        9
    );
    assert_eq!(world.resource::<Match>().controls[1].received_sequence, 0);
}

#[test]
fn lobby_disconnect_preserves_authenticated_room_identity_but_not_an_open_seat() {
    for room in [false, true] {
        let mut world = World::new();
        let old = connection(&mut world, 1);
        let replacement = connection(&mut world, 2);
        let mut game = game();
        game.started = false;
        let token = "ab".repeat(32);
        if room {
            game.configure_room(vec![
                (
                    game.participants.binding(0),
                    web::RosterMember {
                        credential: token.clone(),
                        car: "Orbital".into(),
                    },
                ),
                (
                    game.participants.binding(1),
                    web::RosterMember {
                        credential: "cd".repeat(32),
                        car: "Pizza Boy".into(),
                    },
                ),
            ])
            .unwrap();
        }
        game.controls[0].connection = Some(old);
        game.controls[0].received_sequence = 41;
        let binding = game.participants.binding(0);
        let other_binding = game.participants.binding(1);
        let compatibility = game.compatibility.clone().unwrap();
        world.insert_resource(game);
        bind(&mut world);
        let controller = world.resource::<Match>().controls[0].controller.unwrap();
        world
            .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
                assert!(detach_connection(&mut game, 0, old, &mut commands));
            })
            .unwrap();
        world.entity_mut(old).remove::<Connected>();
        let join = if room {
            Request::Resume {
                token,
                compatibility,
            }
        } else {
            Request::Join { compatibility }
        };
        request(&mut world, replacement, join);
        bind(&mut world);
        let game = world.resource::<Match>();
        assert_eq!(game.controls[0].connection, Some(replacement));
        assert_eq!(game.participants.binding(1), other_binding);
        if room {
            assert_eq!(game.participants.binding(0), binding);
            assert_eq!(game.controls[0].controller, Some(controller));
            assert_eq!(game.controls[0].received_sequence, 41);
        } else {
            assert_ne!(
                game.participants.binding(0).participant,
                binding.participant
            );
            assert_ne!(game.controls[0].controller, Some(controller));
            assert_eq!(game.controls[0].received_sequence, 0);
        }
    }
}
#[test]
fn live_reservations_are_sparse_exclusive_and_cancel_with_fresh_leases() {
    let mut roster = ParticipantRoster::new(8, &[0, 3, 7]).unwrap();
    roster.freeze();
    let unaffected = roster.binding(7);
    let first = roster.reserve_live().unwrap();
    assert_eq!(first.slot, 1);
    assert!(!roster.contains(1));
    assert_eq!(roster.resolve(&first), None);
    let second = roster.reserve_live().unwrap();
    assert_eq!(second.slot, 2);
    roster.release_live(first).unwrap();
    let replacement = roster.reserve_live().unwrap();
    assert_eq!(replacement.slot, 1);
    assert_ne!(first.participant, replacement.participant);
    assert!(roster.commit_live(first).is_err());
    roster.commit_live(replacement).unwrap();
    assert_eq!(roster.slots().collect::<Vec<_>>(), [0, 1, 3, 7]);
    assert_eq!(roster.binding(7), unaffected);
    while roster.reserve_live().is_ok() {}
    assert!(roster.reserve_live().is_err());
    assert_eq!(roster.all_slots().count(), 8);
}

fn live_game() -> Match {
    let mut game = game();
    game.participants = ParticipantRoster::new(8, &[0, 3, 7]).unwrap();
    game.participants.freeze();
    game.controls = (0..8).map(|_| ControllerState::default()).collect();
    game.room_only = true;
    game.session.as_mut().unwrap().capacity = 8;
    game
}

fn room_change(
    world: &mut World,
    change: web::RoomMembership,
) -> Result<web::MembershipReply, &'static str> {
    let (response, receive) = tokio::sync::oneshot::channel();
    let mut request = Some(web::MembershipCommand { change, response });
    world
        .run_system_once(
            move |mut game: ResMut<Match>,
                  mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
                  mut commands: Commands| {
                game.room_membership(request.take().unwrap(), &mut links, &mut commands);
            },
        )
        .unwrap();
    receive.blocking_recv().unwrap()
}

#[test]
fn room_live_admission_is_prepared_idempotent_and_cancelled_on_end() {
    let mut world = World::new();
    world.insert_resource(live_game());
    let credential = "ab".repeat(32);
    assert!(
        room_change(
            &mut world,
            web::RoomMembership::Admit {
                credential: credential.clone(),
                car: "Minion".into()
            }
        )
        .is_err()
    );
    assert_eq!(
        world.resource::<Match>().participants.all_slots().count(),
        3
    );
    let first = room_change(
        &mut world,
        web::RoomMembership::Admit {
            credential: credential.clone(),
            car: "Orbital".into(),
        },
    )
    .unwrap();
    assert_eq!(first.identity.unwrap().slot, 1);
    assert_eq!(first.tick, None);
    let inspected = room_change(
        &mut world,
        web::RoomMembership::Inspect {
            credential: credential.clone(),
        },
    )
    .unwrap();
    assert_eq!(inspected.identity, first.identity);
    assert!(inspected.pending);

    let duplicate = room_change(
        &mut world,
        web::RoomMembership::Admit {
            credential: credential.clone(),
            car: "Orbital".into(),
        },
    )
    .unwrap();
    assert_eq!(duplicate.identity, first.identity);
    assert_eq!(
        world.resource::<Match>().participants.all_slots().count(),
        4
    );
    room_change(
        &mut world,
        web::RoomMembership::Depart {
            credential: credential.clone(),
        },
    )
    .unwrap();
    assert!(
        world
            .resource::<Match>()
            .participants
            .find_room_credential(&credential)
            .is_none()
    );
    let absent = room_change(
        &mut world,
        web::RoomMembership::Depart {
            credential: credential.clone(),
        },
    )
    .unwrap();
    assert_eq!(absent.identity, None);
    assert_eq!(absent.tick, None);
    let inspected = room_change(
        &mut world,
        web::RoomMembership::Inspect {
            credential: credential.clone(),
        },
    )
    .unwrap();
    assert_eq!(inspected.identity, None);
    assert!(!inspected.pending);

    let next = room_change(
        &mut world,
        web::RoomMembership::Admit {
            credential: "cd".repeat(32),
            car: "Orbital".into(),
        },
    )
    .unwrap();
    assert_eq!(next.identity.unwrap().slot, 1);
    assert_ne!(
        next.identity.unwrap().participant,
        first.identity.unwrap().participant
    );
    world.resource_mut::<Match>().ended = true;
    world
        .run_system_once(
            |mut game: ResMut<Match>,
             mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
             mut commands: Commands| {
                game.maintain_membership(&mut links, &mut commands)
            },
        )
        .unwrap();
    assert_eq!(
        world.resource::<Match>().participants.all_slots().count(),
        3
    );
    assert!(world.resource::<Match>().membership.pending.is_empty());
    assert!(world.resource::<Match>().membership.scheduled.is_empty());
}

#[test]
fn slot_reuse_retires_credentials_controllers_and_queued_commands() {
    let mut world = World::new();
    let old_link = connection(&mut world, 91);
    let new_link = connection(&mut world, 92);
    let mut game = live_game();
    game.controls[0].connection = Some(old_link);
    game.controls[0].received_sequence = 50;
    game.participants.at_slot_mut(0).credential = Some("ab".repeat(32));
    game.participants.at_slot_mut(0).room_credential = Some("cd".repeat(32));
    let old = game.participants.binding(0);
    world.insert_resource(game);
    bind(&mut world);
    let controller = world.resource::<Match>().controls[0].controller.unwrap();
    world.entity_mut(controller).insert(buffer(999, 99));
    world
        .run_system_once(move |mut game: ResMut<Match>, mut commands: Commands| {
            game.retire_live(old, &mut commands)
        })
        .unwrap();
    let fresh = {
        let mut game = world.resource_mut::<Match>();
        assert!(
            game.participants
                .find_credential(&"ab".repeat(32))
                .is_none()
        );
        assert!(
            game.participants
                .find_room_credential(&"cd".repeat(32))
                .is_none()
        );
        assert_eq!(game.controls[0].received_sequence, 0);
        let fresh = game.reserve_live().unwrap();
        game.participants.commit_live(fresh).unwrap();
        game.controls[0].connection = Some(new_link);
        fresh
    };
    bind(&mut world);
    assert_ne!(fresh.participant, old.participant);
    assert_eq!(fresh.slot, old.slot);
    assert_ne!(
        world.resource::<Match>().controls[0].controller,
        Some(controller)
    );
    // Even a retained old entity with stale native records cannot contribute
    // to the new lease's accepted command queue.
    world.entity_mut(controller).insert(ControlledBy {
        owner: old_link,
        lifetime: Lifetime::Persistent,
    });
    world.run_system_once(accept_native_inputs).unwrap();
    let mut game = world.resource_mut::<Match>();
    assert_eq!(game.controls[0].received_sequence, 0);
    assert_eq!(game.controls[0].history.sample(100), Input::default());
    assert!(game.retired_connections.contains(&old_link));
}

#[test]
fn disconnect_is_not_departure_and_pending_timeout_releases_only_its_reservation() {
    let mut world = World::new();
    let link = connection(&mut world, 94);
    let mut game = live_game();
    game.controls[3].connection = Some(link);
    let stable = game.participants.binding(3);
    assert!(game.controls[3].disconnect(link));
    assert_eq!(game.participants.resolve(&stable), Some(3));
    assert!(game.membership.scheduled.is_empty());
    let pending = game.reserve_live().unwrap();
    game.membership
        .pending
        .get_mut(&pending.participant)
        .unwrap()
        .opened = Instant::now() - Duration::from_secs(46);
    world.insert_resource(game);
    world
        .run_system_once(
            |mut game: ResMut<Match>,
             mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
             mut commands: Commands| {
                game.maintain_membership(&mut links, &mut commands)
            },
        )
        .unwrap();
    let game = world.resource::<Match>();
    assert_eq!(game.participants.resolve(&stable), Some(3));
    assert!(!game.participants.joining(usize::from(pending.slot)));
    assert!(game.membership.pending.is_empty());
}

#[test]
fn confirmed_ffa_end_seals_journal_and_cancels_scheduled_and_preparing_admissions() {
    let mut world = World::new();
    let mut game = live_game();
    let directory = env::temp_dir().join(format!(
        "tm4-ffa-end-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let initial = game.session.as_ref().unwrap().clone();
    let mut journal = journal::Journal::create(
        &directory,
        &journal::Header {
            start: initial,
            initial_digest: 123,
        },
    )
    .unwrap();
    for tick in 0..game.tick {
        journal
            .append(
                tick,
                &[Input::default(); 8],
                &[],
                game.last_state.as_ref().unwrap(),
            )
            .unwrap();
    }
    let path = journal.path.clone();
    game.journal = Some(journal);
    world.insert_resource(game);
    let a = room_change(
        &mut world,
        web::RoomMembership::Admit {
            credential: "de".repeat(32),
            car: "Orbital".into(),
        },
    )
    .unwrap()
    .identity
    .unwrap();
    let b = room_change(
        &mut world,
        web::RoomMembership::Admit {
            credential: "ef".repeat(32),
            car: "Pizza Boy".into(),
        },
    )
    .unwrap()
    .identity
    .unwrap();
    world
        .run_system_once(
            move |mut game: ResMut<Match>,
                  mut links: Query<(Entity, &mut MessageSender<Message>), With<Connected>>,
                  mut commands: Commands| {
                let future = game
                    .schedule_admission(usize::from(a.slot), &mut links)
                    .unwrap();
                assert!(future > game.tick);
                assert_eq!(game.membership.pending.len(), 2);
                let tick = game.tick;
                let mut state = game.last_state.clone().unwrap();
                state.completion = game_protocol::MatchCompletion {
                    tick: tick + 1,
                    reasons: 3,
                    winners: 0x81,
                };
                state.round_finished = true;
                game.completed(
                    &mut links,
                    tick,
                    vec![Input::default(); 8],
                    vec![],
                    state,
                    Instant::now(),
                );
                game.maintain_membership(&mut links, &mut commands);
            },
        )
        .unwrap();
    let game = world.resource::<Match>();
    assert!(game.ended && game.journal_sealed);
    assert!(game.membership.pending.is_empty() && game.membership.scheduled.is_empty());
    assert!(game.participants.resolve(&a).is_none() && game.participants.resolve(&b).is_none());
    assert_eq!(
        game.participants.count(),
        3,
        "occupied participants retain final score eligibility"
    );
    assert_eq!(journal::inspect(&path).unwrap().end, journal::End::Finished);
    assert!(
        room_change(
            &mut world,
            web::RoomMembership::Admit {
                credential: "fa".repeat(32),
                car: "Orbital".into()
            }
        )
        .is_err()
    );
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn final_result_uses_authority_scores_and_current_sparse_identity_not_dense_order() {
    let mut game = game();
    game.participants = ParticipantRoster::new(8, &[0, 3, 7]).unwrap();
    game.participants.freeze();
    let departed = game.participants.binding(3);
    game.participants.release_live(departed).unwrap();
    let replacement = game.participants.reserve_live().unwrap();
    game.participants.commit_live(replacement).unwrap();
    let pending = game.participants.reserve_live().unwrap();
    game.participants.at_slot_mut(7).room_credential = Some("guest".into());
    let state = game.last_state.as_mut().unwrap();
    state.scores = (0..8)
        .map(|slot| Score {
            frags: slot,
            deaths: 8 - slot,
        })
        .collect();
    state.completion = game_protocol::MatchCompletion {
        tick: 600,
        reasons: 1,
        winners: 128,
    };
    assert!(game.final_result("match").is_none());
    game.ended = true;
    let result = game.final_result("match").unwrap();
    assert_eq!(result.session_id, "match");
    assert_eq!(
        result
            .participants
            .iter()
            .map(|row| row.identity.slot)
            .collect::<Vec<_>>(),
        [0, 1, 7]
    );
    assert_eq!(result.participants[1].identity, replacement);
    assert_ne!(
        result.participants[1].identity.participant,
        departed.participant
    );
    assert!(
        !result
            .participants
            .iter()
            .any(|row| row.identity == pending)
    );
    assert_eq!(result.participants[2].credential.as_deref(), Some("guest"));
    assert_eq!(result.participants[2].score.frags, 7);
    assert_eq!(result.participants[2].score.deaths, 1);
    assert_eq!(result.completion.winners, 128);
}
